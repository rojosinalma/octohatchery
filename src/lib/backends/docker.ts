import Docker from 'dockerode'
import { PassThrough } from 'node:stream'
import { config } from '../config'
import { log } from '../log'
import { RUNNER_HOST_LABEL, RUNNER_ID_LABEL, RUNNER_LABEL, RUNNER_TYPE_LABEL, type BackendAdapter, type ContainerBackend, type ContainerInfo, type ContainerLogLine } from './types'

const logger = log('docker')
const PIDS_LIMIT = 1024
const MB = 1024 * 1024
/** Lines buffered between the engine and the consumer before the socket is paused. */
const LOG_QUEUE_MAX = 4096

/** `2026-01-02T03:04:05.123456789Z text` (docker `timestamps: true`) → { at, line }. */
export function parseTimestampedLine(raw: string): ContainerLogLine {
  const i = raw.indexOf(' ')
  if (i > 0 && /^\d{4}-\d{2}-\d{2}T[^ ]+$/.test(raw.slice(0, i))) return { at: raw.slice(0, i), line: raw.slice(i + 1) }
  return { at: new Date().toISOString(), line: raw }
}

/** Splits a byte stream into complete lines (trailing `\r` dropped); the last partial line is flushed on end. */
function lineSplitter(onLine: (line: string) => void): PassThrough {
  const out = new PassThrough()
  let rest = ''
  out.on('data', (chunk: Buffer) => {
    rest += chunk.toString('utf8')
    let nl
    while ((nl = rest.indexOf('\n')) >= 0) {
      onLine(rest.slice(0, nl).replace(/\r$/, ''))
      rest = rest.slice(nl + 1)
    }
  })
  out.on('end', () => {
    if (rest) onLine(rest)
    rest = ''
  })
  return out
}

/**
 * `docker logs --follow` as an async iterator: the multiplexed stream is demuxed, split into lines and
 * queued; the socket pauses when the queue is full and the iterator ends when the container exits.
 */
async function* followLogs(docker: Docker, containerId: string, since: string | undefined): AsyncGenerator<ContainerLogLine> {
  const container = docker.getContainer(containerId)
  let stream: NodeJS.ReadableStream
  try {
    stream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      timestamps: true,
      since: since ? Math.floor(new Date(since).getTime() / 1000) : 0,
    })
  } catch (err) {
    if (isNotFound(err)) return
    throw err
  }
  const queue: string[] = []
  let ended = false
  let failure: unknown
  let wake: (() => void) | undefined
  const notify = () => {
    wake?.()
    wake = undefined
  }
  const push = (line: string) => {
    queue.push(line)
    if (queue.length >= LOG_QUEUE_MAX) stream.pause()
    notify()
  }
  const stdout = lineSplitter(push)
  const stderr = lineSplitter(push)
  docker.modem.demuxStream(stream, stdout, stderr)
  stream.on('end', () => {
    stdout.end()
    stderr.end()
    ended = true
    notify()
  })
  stream.on('error', (err: unknown) => {
    failure = err
    ended = true
    notify()
  })
  try {
    while (true) {
      if (queue.length) {
        const line = queue.shift()!
        if (queue.length < LOG_QUEUE_MAX / 2 && stream.isPaused()) stream.resume()
        yield parseTimestampedLine(line)
        continue
      }
      if (ended) break
      await new Promise<void>((resolve) => (wake = resolve))
    }
    if (failure) throw failure
  } finally {
    const s = stream as NodeJS.ReadableStream & { destroy?: () => void }
    s.destroy?.()
  }
}

function dockerOptions(host: string | undefined): Docker.DockerOptions | undefined {
  if (!host) return undefined
  if (host.startsWith('unix://')) return { socketPath: host.slice('unix://'.length) }
  if (host.startsWith('tcp://') || host.startsWith('http://') || host.startsWith('https://')) {
    const u = new URL(host.replace(/^tcp:/, 'http:'))
    return { host: u.hostname, port: Number(u.port || 2375), protocol: u.protocol === 'https:' ? 'https' : 'http' }
  }
  return { socketPath: host }
}

function isNotFound(err: unknown): boolean {
  return (err as { statusCode?: number }).statusCode === 404
}

async function pullIfMissing(docker: Docker, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect()
    return
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
  logger.info(`pull ${image}`)
  const stream = await docker.pull(image)
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()))
  })
}

export const dockerBackend: BackendAdapter = {
  kind: 'docker',
  create(): ContainerBackend {
    const docker = new Docker(dockerOptions(config().dockerHost))
    const toInfo = (c: Docker.ContainerInspectInfo): ContainerInfo => ({
      id: c.Id,
      status: c.State.Status,
      running: c.State.Running,
      exitCode: c.State.Running ? null : c.State.ExitCode,
      labels: c.Config.Labels ?? {},
    })
    return {
      kind: 'docker',
      async ping() {
        try {
          await docker.ping()
          return true
        } catch (err) {
          logger.warn('ping failed', err instanceof Error ? err.message : String(err))
          return false
        }
      },
      async info() {
        try {
          const i = (await docker.info()) as { ServerVersion?: unknown; OperatingSystem?: unknown; NCPU?: unknown; MemTotal?: unknown }
          const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
          const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : null)
          const mem = num(i.MemTotal)
          return { version: str(i.ServerVersion), os: str(i.OperatingSystem), cpus: num(i.NCPU), memoryMb: mem === null ? null : Math.round(mem / 1_048_576) }
        } catch (err) {
          logger.warn('info failed', err instanceof Error ? err.message : String(err))
          return null
        }
      },
      async spawnRunner({ runner, type, jitconfig, env, mounts, network }) {
        await pullIfMissing(docker, type.image)
        const container = await docker.createContainer({
          Image: type.image,
          name: runner.name,
          Env: [`RUNNER_JITCONFIG=${jitconfig}`, ...Object.entries(env).map(([k, v]) => `${k}=${v}`)],
          Labels: {
            [RUNNER_LABEL]: 'true',
            [RUNNER_ID_LABEL]: String(runner.id),
            [RUNNER_TYPE_LABEL]: runner.type,
            [RUNNER_HOST_LABEL]: runner.host,
          },
          HostConfig: {
            Binds: mounts,
            NetworkMode: network,
            Memory: type.memoryMb * MB,
            MemorySwap: type.memoryMb * MB,
            NanoCpus: Math.round(type.cpus * 1e9),
            PidsLimit: PIDS_LIMIT,
            RestartPolicy: { Name: 'no' },
          },
        })
        await container.start()
        logger.info(`start ${runner.name} (${container.id.slice(0, 12)}) image=${type.image}`)
        return container.id
      },
      async inspect(containerId) {
        try {
          return toInfo(await docker.getContainer(containerId).inspect())
        } catch (err) {
          if (isNotFound(err)) return { id: containerId, status: 'missing', running: false, exitCode: null, labels: {} }
          throw err
        }
      },
      async remove(containerId) {
        try {
          await docker.getContainer(containerId).remove({ force: true, v: true })
          logger.info(`remove ${containerId.slice(0, 12)}`)
        } catch (err) {
          if (!isNotFound(err)) throw err
        }
      },
      logs(containerId, opts = {}) {
        logger.debug(`follow logs ${containerId.slice(0, 12)}${opts.since ? ` since ${opts.since}` : ''}`)
        return followLogs(docker, containerId, opts.since)
      },
      async listOwned() {
        const list = await docker.listContainers({ all: true, filters: { label: [`${RUNNER_LABEL}=true`] } })
        return list.map((c) => ({
          id: c.Id,
          status: c.State,
          running: c.State === 'running',
          exitCode: null,
          labels: c.Labels ?? {},
        }))
      },
    }
  },
}

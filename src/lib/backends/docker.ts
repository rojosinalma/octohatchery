import Docker from 'dockerode'
import { config } from '../config'
import { log } from '../log'
import { RUNNER_HOST_LABEL, RUNNER_ID_LABEL, RUNNER_LABEL, RUNNER_TYPE_LABEL, type BackendAdapter, type ContainerBackend, type ContainerInfo } from './types'

const logger = log('docker')
const PIDS_LIMIT = 1024
const MB = 1024 * 1024

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

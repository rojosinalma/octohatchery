import { statSync } from 'node:fs'
import { backend } from './backends'
import { config } from './config'
import { cleanCacheDaemon, DAEMON_STORE, leaseCacheVolume, releaseLease } from './dind-cache'
import { recordEvent } from './events'
import { github } from './github/auth'
import { ensureFollower } from './joblog'
import { runnerLabels } from './labels'
import { log } from './log'
import { metrics } from './metrics'
import { settings } from './settings'
import { adoptedRepos, jobById, markRunnerStarted, runnerTypeByName, slotsView, updateJob, updateRunner, type RunnerRow } from './store'
import type { Runner, RunnerType } from './types'

const logger = log('scheduler')
/** Where the runner image bakes its tools; setup actions read it from RUNNER_TOOL_CACHE. Nothing is mounted there. */
export const TOOL_CACHE_PATH = '/opt/hostedtoolcache'
export const MAX_CLAIM_RETRIES = 3
/** Where the runner image expects the daemon socket (the Docker CLI default). */
export const RUNNER_SOCKET_PATH = '/var/run/docker.sock'
/** Docker-in-Docker sidecar: pinned major of the official image, plain TCP shared with the runner's network namespace (no TLS). */
export const DIND_IMAGE = 'docker:28-dind'
export const DIND_PORT = 2375
export const DIND_ROLE = 'dind'
/**
 * The daemon's command. It listens on loopback only: the runner shares the sidecar's network namespace, so
 * `tcp://localhost:2375` reaches it, and no other container on the runner network can (the daemon is privileged and has
 * no auth). `--tls=false` says so explicitly; without it dockerd waits 15 s on start for a TCP listener without TLS.
 * The first word `dockerd` makes the image's entrypoint keep its dind setup but add no listeners of its own.
 */
export const DIND_CMD = ['dockerd', '--host=unix:///var/run/docker.sock', `--host=tcp://127.0.0.1:${DIND_PORT}`, '--tls=false']
/**
 * The runner's work folder (`_work` under the runner image's home, see the JIT config): GITHUB_WORKSPACE and RUNNER_TEMP
 * live under it. On `dind` types one volume is mounted here in the runner and in its daemon, so a job path passed to
 * `docker run -v` is the same files on both sides.
 */
export const WORK_DIR = '/home/runner/_work'
/** Where the daemon reads per-registry CAs (`<registry>/ca.crt`); `DIND_CERTS_DIR` is mounted here read-only. */
export const DIND_CERTS_PATH = '/etc/docker/certs.d'
/** Set in the job when its daemon runs on a kept store (`dockerCache: repo`): images of earlier jobs may be there. */
export const DOCKER_CACHE_ENV = 'OCTOHATCHERY_DOCKER_CACHE'
/** `runAs: root` runs the runner container as uid and gid 0. */
export const ROOT_USER = '0:0'

/** The host daemon's socket as seen from this process: `DOCKER_HOST` when it names a unix socket, else the default path. */
export function hostSocketPath(dockerHost = config().dockerHost): string {
  if (!dockerHost) return RUNNER_SOCKET_PATH
  if (dockerHost.startsWith('unix://')) return dockerHost.slice('unix://'.length)
  if (dockerHost.startsWith('/')) return dockerHost
  return RUNNER_SOCKET_PATH
}

/** Group id owning the socket, so the runner's user can be added to it; undefined when the socket cannot be inspected. */
export function socketGid(path: string, stat: (p: string) => { gid: number } = statSync): string | undefined {
  try {
    return String(stat(path).gid)
  } catch {
    return undefined
  }
}

export function dindName(runner: Pick<Runner, 'name'>): string {
  return `${runner.name}-dind`
}

export function workVolumeName(runner: Pick<Runner, 'name'>): string {
  return `${runner.name}-work`
}

const DIND_READY_MS = 45_000

/** The runner must not start before its daemon answers, whatever image the runner uses. */
async function waitForDaemon(sidecarId: string, runnerName: string): Promise<void> {
  const until = Date.now() + DIND_READY_MS
  while (Date.now() < until) {
    if ((await backend().exec(sidecarId, ['docker', 'info'])) === 0) return
    await Bun.sleep(500)
  }
  throw new Error(`${runnerName}: docker-in-docker daemon not ready after ${DIND_READY_MS / 1000}s`)
}

/** Env for a runner container: tool cache, buildkit, the type's env, then each secret name resolved from this process. */
export async function runnerEnv(type: RunnerType, env: Record<string, string | undefined> = Bun.env): Promise<Record<string, string>> {
  const out: Record<string, string> = {
    RUNNER_TOOL_CACHE: TOOL_CACHE_PATH,
    // The runner prints every step's output to its stdout, which the node follows into the job log.
    ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT: '1',
    BUILDKIT_HOST: await settings.fetch('buildkit_host', 'tcp://octohatchery-buildkitd:1234'),
    ...type.env,
  }
  // The Actions runner refuses to start as root unless told it may.
  if (type.runAs === 'root') out.RUNNER_ALLOW_RUNASROOT = '1'
  const missing = type.secretEnv.filter((name) => !env[name])
  if (missing.length) throw new Error(`runner type "${type.name}" needs ${missing.join(', ')} in this node's environment`)
  for (const name of type.secretEnv) out[name] = env[name]!
  return out
}

/** `uid:gid` for the container's User, or undefined to keep the image's own user. */
export function runnerUser(type: Pick<RunnerType, 'runAs'>): string | undefined {
  return type.runAs === 'root' ? ROOT_USER : undefined
}

export function runnerMounts(type: RunnerType, socketPath = hostSocketPath()): string[] {
  const mounts = [...type.mounts]
  if (type.docker === 'socket') mounts.push(`${socketPath}:${RUNNER_SOCKET_PATH}`)
  return mounts
}

/** Removes the runner's container and every sidecar labelled with its id on this host's engine. */
export async function removeRunnerContainers(runner: Pick<Runner, 'id' | 'containerId'>): Promise<void> {
  const be = backend()
  if (runner.containerId) await be.remove(runner.containerId)
  await be.removeByRunnerId(runner.id)
}

/**
 * Registers a JIT runner with GitHub and starts its container. On failure the runner is marked `failed`
 * and a bound job goes back to `queued` (or `ignored` after MAX_CLAIM_RETRIES).
 */
export async function materialise(runner: RunnerRow, actor = 'scheduler'): Promise<RunnerRow | undefined> {
  let cacheVolume: string | undefined
  /** True while the daemon on a kept store has not started and been cleaned: a failure then drops the store. */
  let cacheSuspect = false
  try {
    const type = await runnerTypeByName(runner.type)
    if (!type) throw new Error(`runner type "${runner.type}" no longer exists`)
    const repo = runner.repo ?? (await adoptedRepos())[0]?.fullName
    if (!repo) throw new Error('no adopted repository to register the runner with')
    const env = await runnerEnv(type)
    const labels = runnerLabels(type.name, runner.host, type.labels)
    const network = config().runnerNetwork
    let groupAdd: string[] | undefined
    if (type.docker === 'socket') {
      const gid = socketGid(hostSocketPath())
      if (gid) groupAdd = [gid]
      else logger.warn(`${runner.name}: cannot stat ${hostSocketPath()}; the runner gets the socket without its group, so it must be readable by the runner user`)
    }
    const jit = await github().createJitConfig({ repo, name: runner.name, labels })
    logger.info(`registered ${runner.name} with ${repo} (github runner ${jit.runnerId})`)
    let runnerNetwork = network
    const mounts = runnerMounts(type)
    if (type.docker === 'dind') {
      // The daemon starts first and owns the network stack; the runner joins it (`container:<sidecar>`), so a port
      // the daemon publishes (GitHub `services:` ports) is on the job's own localhost, as on a hosted runner.
      // Both containers mount one volume at the work folder, so `docker run -v <job path>:…` sees the job's files.
      const volume = await backend().createVolume({ runner, name: workVolumeName(runner) })
      const sidecarMounts = [`${volume}:${WORK_DIR}`]
      const certs = config().dindCertsDir
      if (certs) sidecarMounts.push(`${certs}:${DIND_CERTS_PATH}:ro`)
      if (type.dockerCache === 'repo') {
        const slots = (await slotsView()).find((s) => s.host === runner.host && s.type === type.name)?.count ?? 1
        cacheVolume = await leaseCacheVolume({ host: runner.host, type: type.name, repo, slots })
        if (cacheVolume) sidecarMounts.push(`${cacheVolume}:${DAEMON_STORE}`)
      }
      let sidecarId: string
      try {
        sidecarId = await backend().spawnSidecar({
          runner,
          name: dindName(runner),
          image: DIND_IMAGE,
          role: DIND_ROLE,
          env: { DOCKER_TLS_CERTDIR: '' },
          network,
          privileged: true,
          cmd: DIND_CMD,
          mounts: sidecarMounts,
        })
        cacheSuspect = Boolean(cacheVolume)
      } finally {
        // From here the engine reports the volume in use (or the spawn failed and the volume is free again).
        if (cacheVolume) releaseLease(cacheVolume)
      }
      await waitForDaemon(sidecarId, runner.name)
      if (cacheVolume) {
        // A kept store: nothing of the last job may still run or exist, only images and the build cache stay.
        const outcome = await cleanCacheDaemon(sidecarId, runner.name)
        cacheSuspect = false
        env[DOCKER_CACHE_ENV] = outcome === 'wiped' ? 'emptied' : 'kept'
        logger.info(`${runner.name}: daemon on cache volume ${cacheVolume} (${outcome})`)
      }
      // A new volume belongs to root; the runner user and any `--user` a job passes must be able to write and delete in it.
      if ((await backend().exec(sidecarId, ['chmod', '0777', WORK_DIR])) !== 0) throw new Error(`${runner.name}: cannot open ${WORK_DIR} on the work volume to the runner user`)
      env.DOCKER_HOST = `tcp://localhost:${DIND_PORT}`
      runnerNetwork = `container:${sidecarId}`
      // nocopy: the runner image's own folder must not be copied over the volume and undo the mode set above.
      mounts.push(`${volume}:${WORK_DIR}:nocopy`)
    }
    const containerId = await backend().spawnRunner({
      runner,
      type,
      jitconfig: jit.encodedJitConfig,
      env,
      mounts,
      network: runnerNetwork,
      groupAdd,
      user: runnerUser(type),
    })
    const updated = await markRunnerStarted(runner.id, { containerId, githubRunnerId: jit.runnerId, repo })
    if (updated) ensureFollower(updated)
    metrics.runnerSpawns.inc()
    await recordEvent(actor, 'runner.spawn', runner.name, { host: runner.host, type: runner.type, repo, jobId: runner.jobId })
    return updated
  } catch (err) {
    logger.error(`spawn ${runner.name} failed`, err instanceof Error ? err : String(err))
    // A sidecar that started before the failure must not outlive the runner it was meant for.
    await backend()
      .removeByRunnerId(runner.id)
      .catch((e) => logger.warn(`cleanup for ${runner.name} failed`, e instanceof Error ? e.message : String(e)))
    // A store the daemon could not start on, or could not be cleaned, is not trusted for the next job.
    if (cacheVolume && cacheSuspect) {
      await backend()
        .removeVolume(cacheVolume)
        .catch((e) => logger.warn(`removing cache volume ${cacheVolume} failed`, e instanceof Error ? e.message : String(e)))
    }
    await updateRunner(runner.id, { state: 'failed', exitedAt: new Date().toISOString() })
    await recordEvent(actor, 'runner.failed', runner.name, { reason: err instanceof Error ? err.message : String(err) })
    if (runner.jobId !== null) await requeue(runner.jobId, err instanceof Error ? err.message : String(err), actor)
    return undefined
  }
}

async function requeue(jobId: number, reason: string, actor: string): Promise<void> {
  const job = await jobById(jobId)
  if (!job) return
  const retries = job.retries + 1
  if (retries >= MAX_CLAIM_RETRIES) {
    await updateJob(job.id, { status: 'ignored', retries, runnerId: null, completedAt: new Date().toISOString() })
    await recordEvent(actor, 'job.ignored', `${job.repo}#${job.githubJobId}`, { reason: `gave up after ${retries} spawn failures: ${reason}` })
  } else {
    await updateJob(job.id, { status: 'queued', retries, runnerId: null })
  }
}

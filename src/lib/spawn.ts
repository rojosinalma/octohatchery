import { backend } from './backends'
import { config } from './config'
import { recordEvent } from './events'
import { github } from './github/auth'
import { runnerLabels } from './labels'
import { log } from './log'
import { metrics } from './metrics'
import { settings } from './settings'
import { adoptedRepos, jobById, runnerTypeByName, updateJob, updateRunner, type RunnerRow } from './store'
import type { RunnerType } from './types'

const logger = log('scheduler')
export const TOOL_CACHE_VOLUME = 'octohatchery-tool-cache'
export const TOOL_CACHE_PATH = '/opt/hostedtoolcache'
export const MAX_CLAIM_RETRIES = 3

/** Env for a runner container: tool cache, buildkit, the type's env, then each secret name resolved from this process. */
export async function runnerEnv(type: RunnerType, env: Record<string, string | undefined> = Bun.env): Promise<Record<string, string>> {
  const out: Record<string, string> = {
    RUNNER_TOOL_CACHE: TOOL_CACHE_PATH,
    BUILDKIT_HOST: await settings.fetch('buildkit_host', 'tcp://octohatchery-buildkitd:1234'),
    ...type.env,
  }
  const missing = type.secretEnv.filter((name) => !env[name])
  if (missing.length) throw new Error(`runner type "${type.name}" needs ${missing.join(', ')} in this node's environment`)
  for (const name of type.secretEnv) out[name] = env[name]!
  return out
}

export function runnerMounts(type: RunnerType): string[] {
  return [`${TOOL_CACHE_VOLUME}:${TOOL_CACHE_PATH}`, ...type.mounts]
}

/**
 * Registers a JIT runner with GitHub and starts its container. On failure the runner is marked `failed`
 * and a bound job goes back to `queued` (or `ignored` after MAX_CLAIM_RETRIES).
 */
export async function materialise(runner: RunnerRow, actor = 'scheduler'): Promise<RunnerRow | undefined> {
  try {
    const type = await runnerTypeByName(runner.type)
    if (!type) throw new Error(`runner type "${runner.type}" no longer exists`)
    const repo = runner.repo ?? (await adoptedRepos())[0]?.fullName
    if (!repo) throw new Error('no adopted repository to register the runner with')
    const env = await runnerEnv(type)
    const labels = runnerLabels(type.name, runner.host, type.labels)
    const jit = await github().createJitConfig({ repo, name: runner.name, labels })
    logger.info(`registered ${runner.name} with ${repo} (github runner ${jit.runnerId})`)
    const containerId = await backend().spawnRunner({
      runner,
      type,
      jitconfig: jit.encodedJitConfig,
      env,
      mounts: runnerMounts(type),
      network: config().runnerNetwork,
    })
    const updated = await updateRunner(runner.id, { state: 'idle', containerId, githubRunnerId: jit.runnerId, repo })
    metrics.runnerSpawns.inc()
    await recordEvent(actor, 'runner.spawn', runner.name, { host: runner.host, type: runner.type, repo, jobId: runner.jobId })
    return updated
  } catch (err) {
    logger.error(`spawn ${runner.name} failed`, err instanceof Error ? err : String(err))
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

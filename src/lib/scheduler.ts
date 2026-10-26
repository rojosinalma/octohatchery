import { sql } from 'drizzle-orm'
import { db, recoverDb } from '../db'
import { toJob, toRunner } from '../db/rows'
import { backend } from './backends'
import { RUNNER_HOST_LABEL, RUNNER_ID_LABEL } from './backends/types'
import { config } from './config'
import { sweepCacheVolumes } from './dind-cache'
import { recordEvent } from './events'
import { startImagePull } from './images'
import { ensureFollower } from './joblog'
import { matchesLabels } from './labels'
import { log } from './log'
import { metrics } from './metrics'
import { refreshGitHubCredential } from './octoforge/github'
import { settings } from './settings'
import { materialise, removeRunnerContainers } from './spawn'
import { reconcileJob } from './reconcile'
import { activeRunners, insertRunner, jobById, listHosts, listRunnerTypes, runnerById, slotsView, updateJob, updateRunner, type JobRow, type RunnerRow } from './store'
import type { RunnerType } from './types'

const logger = log('scheduler')
const CLAIM_BATCH = 50
/** Cache volumes change slowly (idle days, slot counts): the reaper checks them at most this often. */
const CACHE_SWEEP_MS = 10 * 60_000
let lastCacheSweep = 0

/** Tests only: the next `reap` checks the cache volumes again. */
export function resetCacheSweep(): void {
  lastCacheSweep = 0
}

export function runnerName(type: string, host: string): string {
  return `${type}-${host}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** (a) Reap: compare this host's active runners with their containers; exited or vanished → `exited`. */
export async function reap(host = config().hostName): Promise<number> {
  const be = backend()
  const owned = new Map((await be.listOwned()).map((c) => [c.labels[RUNNER_ID_LABEL] ?? '', c]))
  let reaped = 0
  const active = await activeRunners(host)
  const activeIds = new Set(active.map((r) => String(r.id)))
  // Orphans: containers whose runner row is no longer active (killed from another node, or left by a restart).
  for (const [runnerId, c] of owned) {
    if (c.labels[RUNNER_HOST_LABEL] !== host || activeIds.has(runnerId)) continue
    logger.info(`removing orphan container ${c.id.slice(0, 12)} (runner ${runnerId || '?'})`)
    await be.remove(c.id)
    if (runnerId) await be.removeByRunnerId(Number(runnerId))
  }
  // Work volumes whose runner is no longer active (a cleanup that failed, a node that died mid-removal).
  // Rows are read after the volumes: a runner's row exists before its volume, so a spawn in flight is never caught.
  const volumes = await be.listRunnerVolumes()
  const liveIds = new Set((await activeRunners(host)).map((r) => String(r.id)))
  for (const v of volumes) {
    if (v.host !== host || liveIds.has(v.runnerId) || !v.runnerId) continue
    logger.info(`removing orphan volume ${v.name} (runner ${v.runnerId})`)
    await be.removeByRunnerId(Number(v.runnerId)).catch((err) => logger.warn(`remove orphan volume ${v.name} failed`, err instanceof Error ? err.message : String(err)))
  }
  if (Date.now() - lastCacheSweep >= CACHE_SWEEP_MS) {
    lastCacheSweep = Date.now()
    await sweepCacheVolumes(host).catch((err) => logger.warn('cache volume sweep failed', err instanceof Error ? err.message : String(err)))
  }
  for (const runner of active) {
    if (runner.state === 'spawning' && !runner.containerId) continue // not started yet
    const info = runner.containerId ? await be.inspect(runner.containerId) : owned.get(String(runner.id))
    if (info && info.running) {
      ensureFollower(runner) // re-attach after a restart; a no-op while a follower is live
      continue
    }
    const exitedAt = new Date().toISOString()
    // Settled while the runner still counts as live, so a rebind can hand it the job it really ran.
    if (runner.jobId !== null) await settleJob(runner, exitedAt)
    await updateRunner(runner.id, { state: 'exited', exitedAt })
    await removeRunnerContainers(runner)
    metrics.runnerExits.inc()
    await recordEvent('scheduler', 'runner.exit', runner.name, { exitCode: info?.exitCode ?? null, status: info?.status ?? 'missing' })
    reaped++
  }
  return reaped
}

/**
 * The runner's container is gone and its job is not closed: no `completed` webhook came (late, lost, or never sent).
 * GitHub's job API decides (`reconcileJob`, releasing the job from this runner unless GitHub reports it completed).
 * When GitHub moved the job to another runner, the job this runner holds after the rebind is settled next (at most
 * two jobs per runner; the leader's sweep reconciles anything left open). Only when GitHub cannot be asked is the job
 * closed as `unknown`: the runner's exit code says nothing about the job, an ephemeral runner exits 0 after any job
 * and non-zero only for its own errors (actions/runner `ReturnCode`: 1 terminated, 2 retryable, 3 and 4 updating,
 * 5 session conflict).
 */
async function settleJob(runner: RunnerRow, exitedAt: string): Promise<void> {
  const seen = new Set<number>()
  while (seen.size < 2) {
    const jobId = (await runnerById(runner.id))?.jobId ?? null
    if (jobId === null || seen.has(jobId)) return
    seen.add(jobId)
    const job = await jobById(jobId)
    if (!job || job.status === 'completed' || job.status === 'ignored') return
    const r = await reconcileJob(job, { release: runner.id })
    if (!r) {
      logger.warn(`${runner.name} exited, GitHub not asked about job ${job.id} (${job.repo}#${job.githubJobId}): closed as unknown, the sweep asks again`)
      await updateJob(job.id, { status: 'completed', conclusion: 'unknown', completedAt: exitedAt })
      return
    }
    if (r.job.runnerId === runner.id) return
  }
}

/** (b) Claim: for each (type, this host) with a free slot take the oldest matching queued job, inside one transaction. */
export async function claim(host = config().hostName): Promise<RunnerRow[]> {
  const spawned: RunnerRow[] = []
  const types = new Map((await listRunnerTypes()).map((t) => [t.name, t]))
  const knownHosts = (await listHosts()).map((h) => h.name)
  for (const slot of (await slotsView()).filter((s) => s.host === host && s.free > 0)) {
    const type = types.get(slot.type)
    if (!type) continue
    for (let i = 0; i < slot.free; i++) {
      const runner = await claimOne(type, host, knownHosts)
      if (!runner) break
      const live = await materialise(runner)
      if (live) spawned.push(live)
      else metrics.claimFailures.inc()
    }
  }
  return spawned
}

async function claimOne(type: RunnerType, host: string, knownHosts: string[]): Promise<RunnerRow | undefined> {
  return db().transaction(async (tx) => {
    const lock = tx.dialect === 'postgres' ? sql`for update skip locked` : sql``
    const rows = await tx.all(sql`select * from jobs where status = 'queued' order by queued_at, id limit ${CLAIM_BATCH} ${lock}`)
    const job = rows.map(toJob).find((j) => matchesLabels(j.labels, { type: type.name, typeLabels: type.labels, host, knownHosts }))
    if (!job) return undefined
    const runnerRow = await insertRunner({ name: runnerName(type.name, host), host, type: type.name, jobId: job.id, repo: job.repo, jobName: job.name }, tx)
    const [claimed] = await tx.all(sql`update jobs set status = 'claimed', runner_id = ${runnerRow.id} where id = ${job.id} and status = 'queued' returning *`)
    if (!claimed) throw new Error(`job ${job.id} was claimed concurrently`)
    logger.info(`claimed ${job.repo}#${job.githubJobId} "${job.name}" for ${runnerRow.name}`)
    return runnerRow
  })
}

/** (c) Start runners that were requested by hand (`spawn`) or left in `spawning` with no container. */
export async function startPending(host = config().hostName): Promise<number> {
  const pending = await db().all(sql`select * from runners where host = ${host} and state = 'spawning' and container_id is null order by id`)
  let n = 0
  for (const row of pending.map(toRunner)) {
    if (await materialise(row)) n++
  }
  return n
}

let running = false
let timer: ReturnType<typeof setTimeout> | undefined
let stopped = false

/** One scheduler pass. Never throws: errors are logged with their stack and the next tick retries. */
export async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    await reap()
    await startPending()
    await claim()
    await startImagePull()
  } catch (err) {
    logger.error('tick failed', err instanceof Error ? err : String(err))
    await recoverDb()
  } finally {
    running = false
  }
}

export function startScheduler(): void {
  stopped = false
  const loop = async () => {
    if (stopped) return
    // Every node picks up a credential Octoforge delivered to another node from the shared settings table.
    await refreshGitHubCredential().catch((err) => logger.error('github credential refresh failed', err instanceof Error ? err : String(err)))
    await tick()
    const s = await settings.fetchInt('scheduler_tick_s', 5)
    timer = setTimeout(loop, Math.max(1, s) * 1000)
  }
  void loop()
}

export function stopScheduler(): void {
  stopped = true
  if (timer) clearTimeout(timer)
}

// Re-exported so callers can test the pure matching without the loop.
export { matchesLabels } from './labels'
export type { JobRow }

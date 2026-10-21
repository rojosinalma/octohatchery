import { sql } from 'drizzle-orm'
import { cpus, platform, release, totalmem } from 'node:os'
import pkg from '../../package.json'
import { db, recoverDb } from '../db'
import { backend } from './backends'
import { config } from './config'
import { recordEvent } from './events'
import { notServedReason } from './github/accounts'
import { github } from './github/auth'
import { reportImages } from './images'
import { backfillSteps } from './joblog'
import { SELF_HOSTED } from './labels'
import { log } from './log'
import { settings } from './settings'
import { removeRunnerContainers } from './spawn'
import { reconcileJob } from './reconcile'
import { activeRunners, adoptedRepos, insertJobIfNew, jobsToReconcile, updateRunner, upsertHost } from './store'
import type { HostSpecs } from './types'

const logger = log('sweep')

let leader = false
let stopped = false
let timers: ReturnType<typeof setTimeout>[] = []
let lastPollAt = 0

export function isLeader(): boolean {
  return leader
}

/**
 * Single mode is always leader. Cluster mode asks Postgres for the advisory lock on every pass, so a node whose
 * lock session died (failover, network) steps down within one sweep instead of staying leader forever, and a
 * node that got the lock on a standby never counts.
 */
export async function electLeader(): Promise<boolean> {
  const was = leader
  if (config().mode === 'single') {
    leader = true
  } else {
    try {
      leader = await db().tryLeaderLock()
    } catch (err) {
      leader = false
      logger.warn('leader lock check failed; stepping down until the database answers', err instanceof Error ? err : String(err))
    }
  }
  if (leader && !was) logger.info(`this node (${config().hostName}) is the leader`)
  if (!leader && was) logger.warn(`this node (${config().hostName}) lost the leader lock`)
  return leader
}

/** `PRETTY_NAME` from /etc/os-release when readable, else `<platform> <release>`; read once. */
let osName: string | undefined
async function osPrettyName(): Promise<string> {
  if (osName) return osName
  try {
    const text = await Bun.file('/etc/os-release').text()
    const m = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(text)
    if (m?.[1]) return (osName = m[1])
  } catch {
    // not Linux, or no such file: fall through
  }
  return (osName = `${platform()} ${release()}`)
}

/**
 * What this node knows about its host. The container engine sees the real machine (CPUs, memory, OS), so its
 * answer wins; a field the engine leaves out falls back to the process's own view (inside a container: the
 * container's). While the engine is down nothing but the app version is reported, so the stored values stay.
 */
export async function hostSpecs(dockerOk: boolean): Promise<HostSpecs> {
  const engine = dockerOk ? await backend().info() : null
  if (!engine) return { cpus: null, memoryMb: null, os: null, dockerVersion: null, appVersion: pkg.version }
  return {
    cpus: engine.cpus ?? (cpus().length || null),
    memoryMb: engine.memoryMb ?? (Math.round(totalmem() / 1_048_576) || null),
    os: engine.os ?? (await osPrettyName()),
    dockerVersion: engine.version,
    appVersion: pkg.version,
  }
}

/** Heartbeat: upsert this host as online with its docker state and specs; mark silent hosts offline. */
export async function heartbeat(): Promise<void> {
  const dockerOk = await backend().ping()
  await upsertHost({ name: config().hostName, isLeader: leader, dockerOk, specs: await hostSpecs(dockerOk) })
  if (dockerOk) await reportImages().catch((err) => logger.warn('image inventory failed', err instanceof Error ? err.message : String(err)))
  const grace = 3 * (await settings.fetchInt('heartbeat_s', 15))
  const cutoff = new Date(Date.now() - grace * 1000).toISOString()
  await db().run(sql`update hosts set status = 'offline' where last_seen_at < ${cutoff} and status <> 'offline'`)
}

/** Polling fallback: queued jobs GitHub knows about that no webhook delivered. */
export async function pollQueuedJobs(): Promise<number> {
  let added = 0
  for (const repo of await adoptedRepos()) {
    // An adopted repo on an account that is no longer served is skipped, as its webhooks are.
    const notServed = await notServedReason(github().installs, repo.fullName.split('/')[0]!)
    if (notServed) {
      logger.debug(`poll ${repo.fullName} skipped: ${notServed}`)
      continue
    }
    let jobs
    try {
      jobs = await github().listQueuedJobs(repo.fullName)
    } catch (err) {
      logger.warn(`poll ${repo.fullName} failed`, err instanceof Error ? err.message : String(err))
      continue
    }
    for (const j of jobs) {
      const status = j.labels.map((l) => l.toLowerCase()).includes(SELF_HOSTED) ? 'queued' : 'ignored'
      const inserted = await insertJobIfNew({ repo: repo.fullName, ...j, status })
      if (inserted) added++
    }
  }
  if (added) logger.info(`poll found ${added} new queued job(s)`)
  return added
}

/**
 * Runners idle longer than `stale_runner_minutes`: remove the container, deregister, mark `removed`. GitHub is asked
 * first: a runner it reports busy is running a job (a webhook was lost or arrived out of order) and is kept.
 */
export async function removeStaleRunners(nowMs = Date.now()): Promise<number> {
  const minutes = await settings.fetchInt('stale_runner_minutes', 5)
  const cutoff = new Date(nowMs - minutes * 60_000).toISOString()
  let removed = 0
  for (const r of await activeRunners()) {
    if (r.state !== 'idle' || r.createdAt >= cutoff) continue
    if (r.githubRunnerId !== null && r.repo) {
      let onGitHub
      try {
        onGitHub = await github().getRunner(r.repo, r.githubRunnerId)
      } catch (err) {
        logger.warn(`${r.name}: GitHub runner state unknown, kept until the next pass`, err instanceof Error ? err.message : String(err))
        continue
      }
      if (onGitHub?.busy) {
        logger.info(`${r.name} is idle here but busy on GitHub: kept and marked busy`)
        await updateRunner(r.id, { state: 'busy' })
        continue
      }
    }
    await removeRunnerContainers(r).catch((err) => logger.warn(`remove ${r.name} containers failed`, err))
    if (r.githubRunnerId !== null && r.repo) await github().deleteRunner(r.repo, r.githubRunnerId).catch((err) => logger.warn(`deregister ${r.name} failed`, err))
    await updateRunner(r.id, { state: 'removed', exitedAt: new Date(nowMs).toISOString() })
    await recordEvent('sweep', 'runner.stale', r.name, { idleMinutes: minutes })
    removed++
  }
  return removed
}

/** How far back the reconcile pass looks; older rows are history, a restart must not ask GitHub about a month of jobs. */
const RECONCILE_WINDOW_MS = 24 * 3_600_000
/** Job id → when this process last asked GitHub about it and whether GitHub reported it completed (then never again). */
const reconciled = new Map<number, { at: number; final: boolean }>()

/** Tests only: forget which jobs this process already reconciled. */
export function resetReconciled(): void {
  reconciled.clear()
}

/**
 * Leader pass: rows a missing webhook may have left wrong (`jobsToReconcile`: open with no live runner, or completed
 * with a guessed conclusion, within the last 24 h) are reconciled with GitHub's job API, at most `max` calls per pass.
 * A job GitHub reports completed is asked about once per process; an open one again after `poll_interval_s`.
 * Returns how many rows changed.
 */
export async function reconcileJobs(max = 10, nowMs = Date.now()): Promise<number> {
  const windowStart = nowMs - RECONCILE_WINDOW_MS
  for (const [id, seen] of reconciled) if (seen.at < windowStart) reconciled.delete(id)
  const recheckMs = (await settings.fetchInt('poll_interval_s', 300)) * 1000
  let calls = 0
  let changed = 0
  for (const job of await jobsToReconcile(new Date(windowStart).toISOString(), max + reconciled.size)) {
    if (calls >= max) break
    const seen = reconciled.get(job.id)
    if (seen && (seen.final || nowMs - seen.at < recheckMs)) continue
    calls++
    const r = await reconcileJob(job)
    reconciled.set(job.id, { at: nowMs, final: r?.github.status === 'completed' })
    if (r?.changed) changed++
  }
  if (changed) logger.info(`reconciled ${changed} job(s) with GitHub`)
  return changed
}

/** Finished jobs, runners, events and image pulls older than `retention_days` are deleted. */
export async function purgeRetention(nowMs = Date.now()): Promise<{ jobs: number; runners: number; events: number; pulls: number }> {
  const days = await settings.fetchInt('retention_days', 30)
  const cutoff = new Date(nowMs - days * 86_400_000).toISOString()
  const d = db()
  const finished = sql`status in ('completed', 'ignored') and coalesce(completed_at, queued_at) < ${cutoff}`
  // Explicit, so the purge does not depend on foreign-key enforcement being on in the database.
  await d.run(sql`delete from job_logs where job_id in (select id from jobs where ${finished})`)
  const jobs = await d.all(sql`delete from jobs where ${finished} returning id`)
  const runners = await d.all(sql`delete from runners where state in ('exited', 'failed', 'removed') and coalesce(exited_at, created_at) < ${cutoff} returning id`)
  const events = await d.all(sql`delete from events where at < ${cutoff} returning id`)
  const pulls = await d.all(sql`delete from image_pulls where status in ('done', 'failed') and coalesce(finished_at, created_at) < ${cutoff} returning id`)
  const out = { jobs: jobs.length, runners: runners.length, events: events.length, pulls: pulls.length }
  if (out.jobs || out.runners || out.events || out.pulls) logger.info(`purged ${out.jobs} jobs, ${out.runners} runners, ${out.events} events, ${out.pulls} image pulls older than ${days}d`)
  return out
}

/** One leader pass; polling honours its own interval. Never throws. */
export async function sweepOnce(): Promise<void> {
  try {
    await backfillSteps()
    if (!(await electLeader())) return
    await removeStaleRunners()
    await purgeRetention()
    await reconcileJobs()
    const pollEvery = (await settings.fetchInt('poll_interval_s', 300)) * 1000
    if (Date.now() - lastPollAt >= pollEvery) {
      lastPollAt = Date.now()
      await pollQueuedJobs()
    }
  } catch (err) {
    logger.error('sweep failed', err instanceof Error ? err : String(err))
    await recoverDb()
  }
}

export function startSweep(): void {
  stopped = false
  const every = async (name: string, fn: () => Promise<void>, intervalKey: string, fallback: number) => {
    const loop = async () => {
      if (stopped) return
      try {
        await fn()
      } catch (err) {
        logger.error(`${name} failed`, err instanceof Error ? err : String(err))
      }
      const s = await settings.fetchInt(intervalKey, fallback)
      timers.push(setTimeout(loop, Math.max(1, s) * 1000))
    }
    void loop()
  }
  void every('heartbeat', heartbeat, 'heartbeat_s', 15)
  void every('sweep', sweepOnce, 'scheduler_tick_s', 5)
}

export function stopSweep(): void {
  stopped = true
  for (const t of timers) clearTimeout(t)
  timers = []
}

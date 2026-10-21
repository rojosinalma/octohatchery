import { recordEvent } from './events'
import { github } from './github/auth'
import type { JobDetails } from './github/types'
import { log } from './log'
import { ACTIVE_RUNNER_STATES, jobById, rebindJob, runnerById, runnerByName, updateJob, updateRunner, type JobPatch, type JobRow } from './store'
import type { Actor } from './types'

// GitHub's job API as the authority whenever a webhook is missing: one function moves a job row to what GitHub
// reports (runner, status, conclusion, timestamps, steps). The reaper, the finaliser and the leader's sweep use it.

const loggers = { webhook: log('http'), github: log('github') }
const logger = loggers.github

/** GitHub job statuses that mean "not started yet" (`waiting` = environment approval, `requested`/`pending` = not queued yet). */
const NOT_STARTED = new Set(['queued', 'waiting', 'pending', 'requested'])

/**
 * Moves the job to the runner GitHub says runs it (see `rebindJob`); one audit event per move. A runner name that
 * is not ours (or no name) leaves the binding as it is.
 */
export async function followGitHub(job: JobRow, runnerName: string | null | undefined, actor: 'webhook' | 'github' = 'webhook'): Promise<JobRow> {
  if (!runnerName) return job
  const moved = await rebindJob(job.id, runnerName)
  if (!moved) return job
  const target = `${job.repo}#${job.githubJobId}`
  loggers[actor].info(`${target} "${job.name}" runs on ${runnerName}, not on runner ${job.runnerId ?? 'none'}: binding moved${moved.displacedJobId !== null ? ` (job ${moved.displacedJobId} → runner ${moved.previousRunnerId ?? 'none'})` : ''}`)
  await recordEvent(actor as Actor, 'job.rebound', target, { runner: runnerName, from: job.runnerId, displacedJob: moved.displacedJobId })
  return moved.job
}

export type Reconciled = {
  /** The row after reconciling. */
  job: JobRow
  /** True when status, conclusion or runner binding changed (then a `job.reconciled` event was recorded). */
  changed: boolean
  /** What GitHub answered. */
  github: JobDetails
  from: { status: JobRow['status']; conclusion: string | null; runnerId: number | null }
}

/**
 * A rebind moves live log lines between the two jobs involved, so it is safe only while neither log is final:
 * the job itself is open, and the job the named runner holds now (if another one) has no final log either.
 */
async function canRebind(job: JobRow, runnerName: string): Promise<boolean> {
  if (job.status === 'completed' || job.logSource !== null) return false
  const runner = await runnerByName(runnerName)
  if (!runner || runner.jobId === null || runner.jobId === job.id) return true
  const held = await jobById(runner.jobId)
  return !held || held.logSource === null
}

/**
 * Asks GitHub for the job (`GET /repos/{o}/{r}/actions/jobs/{id}`) and applies the answer:
 * 1. binding: an open job follows the runner GitHub names (`followGitHub`);
 * 2. `release`: the runner with this id is gone; a job GitHub does not report completed is unbound from it
 *    (another runner runs it, or it waits for one);
 * 3. status: `completed` → completed with GitHub's conclusion and time; `in_progress` → in_progress with its start;
 *    not started yet → back to `queued` only from `claimed` when no live runner of ours holds it. A completed row is
 *    never reopened, an `ignored` row never touched;
 * 4. steps: GitHub's, when it reports any.
 * One `job.reconciled` event (actor `github`) when status, conclusion or binding changed. Returns null when GitHub
 * could not be asked or the update failed; the error is logged with the job and the row is left as it is.
 */
export function reconcileJob(job: JobRow, opts: { release?: number } = {}): Promise<Reconciled | null> {
  // One reconcile per job at a time in this process (the reaper and the finaliser meet at a runner's exit): the
  // second one starts from the row the first one wrote, so it records no second event for the same change.
  const run = (inFlight.get(job.id) ?? Promise.resolve()).catch(() => undefined).then(async () => reconcileOnce((await jobById(job.id)) ?? job, opts))
  const settledRun = run.finally(() => {
    if (inFlight.get(job.id) === settledRun) inFlight.delete(job.id)
  })
  inFlight.set(job.id, settledRun)
  return run
}

/** Reconciles in flight by job id; an entry lives only while its call runs. */
const inFlight = new Map<number, Promise<unknown>>()

async function reconcileOnce(job: JobRow, opts: { release?: number }): Promise<Reconciled | null> {
  const target = `${job.repo}#${job.githubJobId}`
  let details: JobDetails
  try {
    details = await github().getJob(job.repo, job.githubJobId)
  } catch (err) {
    logger.warn(`job ${job.id} (${target}): GitHub job state not fetched, row left as it is`, err instanceof Error ? err.message : String(err))
    return null
  }
  const from = { status: job.status, conclusion: job.conclusion, runnerId: job.runnerId }
  try {
    if (job.status === 'ignored') return { job, changed: false, github: details, from }
    let cur = job
    if (details.runnerName && (await canRebind(job, details.runnerName))) cur = await followGitHub(job, details.runnerName, 'github')

    const patch: JobPatch = {}
    let runnerId = cur.runnerId
    if (opts.release !== undefined && runnerId === opts.release && details.status !== 'completed') {
      const runner = await runnerById(opts.release)
      if (runner?.jobId === cur.id) await updateRunner(runner.id, { jobId: null, jobName: null })
      runnerId = patch.runnerId = null
    }

    if (details.status === 'completed') {
      if (cur.status !== 'completed') patch.status = 'completed'
      if (cur.conclusion !== details.conclusion) patch.conclusion = details.conclusion
      if (details.completedAt && cur.completedAt !== details.completedAt) patch.completedAt = details.completedAt
      if (!details.completedAt && !cur.completedAt) patch.completedAt = new Date().toISOString()
      if (details.startedAt && cur.startedAt !== details.startedAt) patch.startedAt = details.startedAt
    } else if (cur.status !== 'completed') {
      if (details.status === 'in_progress') {
        if (cur.status !== 'in_progress') patch.status = 'in_progress'
        const startedAt = details.startedAt ?? cur.startedAt ?? new Date().toISOString()
        if (cur.startedAt !== startedAt) patch.startedAt = startedAt
      } else if (NOT_STARTED.has(details.status) && cur.status === 'claimed') {
        const runner = runnerId === null ? undefined : await runnerById(runnerId)
        const live = runner !== undefined && runner.id !== opts.release && ACTIVE_RUNNER_STATES.includes(runner.state)
        if (!live) {
          patch.status = 'queued'
          if (runner?.jobId === cur.id) await updateRunner(runner.id, { jobId: null, jobName: null })
          if (runnerId !== null) patch.runnerId = runnerId = null
        }
      }
    }
    if (details.steps.length && JSON.stringify(details.steps) !== JSON.stringify(cur.steps)) patch.steps = details.steps
    if (Object.keys(patch).length) cur = (await updateJob(cur.id, patch)) ?? cur

    const changed = cur.status !== from.status || cur.conclusion !== from.conclusion || cur.runnerId !== from.runnerId
    if (changed) {
      logger.info(`job ${job.id} (${target}) reconciled with GitHub: ${from.status}/${from.conclusion ?? '-'} → ${cur.status}/${cur.conclusion ?? '-'}, runner ${from.runnerId ?? 'none'} → ${cur.runnerId ?? 'none'}`)
      await recordEvent('github', 'job.reconciled', target, {
        fromStatus: from.status,
        toStatus: cur.status,
        fromConclusion: from.conclusion,
        toConclusion: cur.conclusion,
        runner: details.runnerName,
      })
    }
    return { job: cur, changed, github: details, from }
  } catch (err) {
    logger.error(`job ${job.id} (${target}): reconcile failed`, err instanceof Error ? err : String(err))
    return null
  }
}

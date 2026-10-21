import { db } from '../db'
import { backend } from './backends'
import { bus } from './bus'
import { config } from './config'
import { github } from './github/auth'
import { log } from './log'
import { reconcileJob } from './reconcile'
import { settings } from './settings'
import { appendLogLines, deleteLogLines, jobById, jobsWithoutSteps, logCursor, runnerById, updateJob, type JobRow, type RunnerRow } from './store'

// Job log follower: one responsibility — follow a runner container's output, store it in batches,
// announce each batch on the bus, and when the container exits replace it with GitHub's final log.

const logger = log('joblog')
const KB = 1024
/** A batch is written when it holds this many lines or when this much time passed since its first line. */
const FLUSH_LINES = 64
const FLUSH_MS = 500
/** GitHub answers 404 until the job's log is ready; these waits (≈2 min in total) bound the retries. */
const DEFAULT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 60_000]
/** After a runner exited, the owning node has this long to finalise before a reader may call the log complete. */
export const FINALISE_GRACE_MS = DEFAULT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 30_000
export const TRUNCATED_NOTICE = (capKb: number) => `[octohatchery] log truncated at ${capKb} KB (setting log_max_kb); the full log is on GitHub`

let retryDelays = DEFAULT_RETRY_DELAYS_MS
let flushMs = FLUSH_MS

/** Followers in flight on this node, by runner id; the promise settles when finalisation is done. */
const active = new Map<number, Promise<void>>()

/** Tests only: shorter waits and a clean follower table (followers of a closed database are abandoned). */
export function configureJobLog(opts: { retryDelaysMs?: number[]; flushMs?: number } = {}): void {
  retryDelays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  flushMs = opts.flushMs ?? FLUSH_MS
  active.clear()
  backfilled.clear()
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const byteLength = (line: string) => Buffer.byteLength(line, 'utf8') + 1

export function isFollowing(runnerId: number): boolean {
  return active.has(runnerId)
}

/** Settles when every follower started so far has finished (tests). */
export async function settled(): Promise<void> {
  await Promise.allSettled([...active.values()])
}

/**
 * Starts following `runner`'s container when this node owns it, it has a job and nothing follows it yet.
 * Idempotent; safe to call on every scheduler tick (re-attach after a restart resumes from the last stored line).
 */
export function ensureFollower(runner: RunnerRow): void {
  if (runner.jobId === null || !runner.containerId || runner.host !== config().hostName) return
  if (active.has(runner.id)) return
  const run = follow(runner.id, runner.jobId, runner.containerId, runner.name)
    .catch((err) => logger.error(`follower for ${runner.name} failed`, err instanceof Error ? err : String(err)))
    .finally(() => active.delete(runner.id))
  active.set(runner.id, run)
}

/** Appends `lines` honouring the cap; returns what was stored and whether the cap was hit. */
async function storeBatch(job: JobRow, fromSeq: number, lines: { at: string; line: string }[], bytes: number): Promise<{ stored: number; bytes: number; truncated: boolean }> {
  const capKb = await settings.fetchInt('log_max_kb', 2048)
  const cap = capKb * KB
  const keep: { at: string; line: string }[] = []
  let truncated = false
  for (const l of lines) {
    const size = byteLength(l.line)
    if (bytes + size > cap) {
      truncated = true
      keep.push({ at: l.at, line: TRUNCATED_NOTICE(capKb) })
      break
    }
    bytes += size
    keep.push(l)
  }
  const stored = await appendLogLines(job.id, fromSeq, keep)
  await updateJob(job.id, { logBytes: bytes, logTruncated: truncated }, undefined, { silent: true })
  if (stored.length) bus.emit('log', { jobId: job.id, lines: stored })
  return { stored: stored.length, bytes, truncated }
}

async function follow(runnerId: number, jobId: number, containerId: string, runnerName: string): Promise<void> {
  let job = await jobById(jobId)
  if (!job) return
  if (job.logSource !== null) return // already final (restart after completion)
  const cursor = await logCursor(jobId)
  let seq = cursor.seq
  let bytes = job.logBytes
  let truncated = job.logTruncated
  logger.info(`following ${runnerName} for job ${jobId}${cursor.at ? ` from seq ${cursor.seq}` : ''}`)

  /**
   * GitHub may give this runner another job than the one it was claimed for (`rebindJob`); each batch goes to the
   * job it is bound to now. The rebind moved this runner's earlier lines along, so that job's cursor continues them.
   */
  const target = async (): Promise<JobRow | undefined> => {
    const bound = (await runnerById(runnerId))?.jobId ?? null
    if (bound === (job?.id ?? null)) return job
    const next = bound === null ? undefined : await jobById(bound)
    job = next && next.logSource === null ? next : undefined
    seq = job ? (await logCursor(job.id)).seq : 0
    bytes = job?.logBytes ?? 0
    truncated = job?.logTruncated ?? false
    logger.info(`${runnerName} now runs ${job ? `job ${job.id}` : 'no job of ours'}; output follows it`)
    return job
  }

  let batch: { at: string; line: string }[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let writing: Promise<void> = Promise.resolve()
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (!batch.length) return writing
    const lines = batch
    batch = []
    writing = writing.then(async () => {
      try {
        const into = await target()
        if (!into || truncated) return
        const out = await storeBatch(into, seq + 1, lines, bytes)
        seq += out.stored
        bytes = out.bytes
        truncated = out.truncated
      } catch (err) {
        // One lost batch of the live view; GitHub's final log replaces it. The chain must survive for the next batch.
        logger.warn(`${runnerName}: ${lines.length} live line(s) not stored`, err instanceof Error ? err.message : String(err))
      }
    })
    return writing
  }

  if (!truncated) {
    try {
      for await (const l of backend().logs(containerId, { since: cursor.at ?? undefined })) {
        if (cursor.at && l.at <= cursor.at) continue // re-delivered by `since` (second precision)
        if (truncated) continue // cap reached: drain without storing so finalisation lines up with the container's exit
        batch.push(l)
        if (batch.length >= FLUSH_LINES) void flush()
        else timer ??= setTimeout(() => void flush(), flushMs)
      }
    } catch (err) {
      logger.warn(`log stream of ${runnerName} ended with an error`, err instanceof Error ? err.message : String(err))
    }
    await flush()
    await writing
  }
  const final = await target()
  logger.info(`${runnerName} output ended for job ${final?.id ?? jobId} (${seq} lines, ${Math.round(bytes / KB)} KB${truncated ? ', truncated' : ''})`)
  if (final) await finalise(final, runnerId)
}

/**
 * Stores the steps GitHub reports for `job` (authoritative timestamps, the webhook's copy may be older or missing).
 * A failure is logged and swallowed: steps are a reading aid, never a reason to lose the log. Returns true when stored.
 */
export async function storeSteps(job: Pick<JobRow, 'id' | 'repo' | 'githubJobId'>): Promise<boolean> {
  try {
    const details = await github().getJob(job.repo, job.githubJobId)
    if (!details.steps.length) return false
    await updateJob(job.id, { steps: details.steps })
    logger.debug(`job ${job.id} (${job.repo}#${job.githubJobId}): stored ${details.steps.length} steps`)
    return true
  } catch (err) {
    logger.warn(`job ${job.id} (${job.repo}#${job.githubJobId}): steps not fetched`, err instanceof Error ? err.message : String(err))
    return false
  }
}

/** Fetches and stores the job's check-run annotations; a failure is logged and leaves what is stored. */
export async function storeAnnotations(job: Pick<JobRow, 'id' | 'repo' | 'githubJobId'>): Promise<boolean> {
  try {
    const annotations = await github().listJobAnnotations(job.repo, job.githubJobId, ANNOTATIONS_MAX)
    await updateJob(job.id, { annotations }, undefined, { silent: true })
    if (annotations.length) logger.debug(`job ${job.id} (${job.repo}#${job.githubJobId}): stored ${annotations.length} annotations`)
    return true
  } catch (err) {
    logger.warn(`job ${job.id} (${job.repo}#${job.githubJobId}): annotations not fetched`, err instanceof Error ? err.message : String(err))
    return false
  }
}

/** Annotations kept per job; GitHub itself caps them per step, a job rarely carries more. */
const ANNOTATIONS_MAX = 50

/** Jobs this process already asked GitHub about (bounded by the rows the retention window holds). */
const backfilled = new Set<number>()

/**
 * Finished jobs with a GitHub log but no steps (rows from before steps were stored, or whose fetch failed): at most
 * `max` GitHub calls per pass, each job once per process. Every node runs it; a second node finding the same row
 * writes the same steps, so no coordination is needed.
 */
export async function backfillSteps(max = 5): Promise<number> {
  let n = 0
  let calls = 0
  for (const job of await jobsWithoutSteps(max + backfilled.size)) {
    if (backfilled.has(job.id) || calls >= max) continue
    backfilled.add(job.id)
    calls++
    if (await storeSteps(job)) n++
  }
  if (n) logger.info(`backfilled steps for ${n} job(s)`)
  return n
}

/**
 * Reconciles the job with GitHub's job API (status, conclusion, steps, binding: `reconcileJob`), then replaces the
 * live lines with GitHub's flat job log (the view splits it into steps by time and step openers) and stores the job's
 * annotations. After the retry budget the live lines stay and the source is marked `runner`. With `runnerId` (the
 * runner whose output ended): when GitHub says another runner ran the job, its log is left to that runner and the job
 * this runner holds after the rebind is finalised instead (one hop).
 */
export async function finalise(job: JobRow, runnerId?: number, hop = false): Promise<void> {
  const r = await reconcileJob(job)
  if (r && runnerId !== undefined && r.job.runnerId !== runnerId) {
    const held = (await runnerById(runnerId))?.jobId ?? null
    logger.info(`job ${job.id} (${job.repo}#${job.githubJobId}) did not run on runner ${runnerId} (GitHub: ${r.github.runnerName ?? 'no runner'}, ${r.github.status}); its log is not finalised from here`)
    if (hop || held === null || held === job.id) return
    const next = await jobById(held)
    if (next && next.logSource === null) await finalise(next, runnerId, true)
    return
  }
  if (r && runnerId !== undefined && r.github.status !== 'completed') {
    // Open on GitHub and not on this runner (waiting for one, or on a runner that is not ours): there is no final log
    // to fetch, and marking the source would stop the follower of the runner that takes it later.
    const self = await runnerById(runnerId)
    if (!self || r.github.runnerName !== self.name) {
      logger.info(`job ${job.id} (${job.repo}#${job.githubJobId}) is ${r.github.status} on GitHub (runner ${r.github.runnerName ?? 'none'}); its log is not finalised from here`)
      return
    }
  }
  let annotated = false
  for (let attempt = 0; ; attempt++) {
    try {
      const text = await github().getJobLog(job.repo, job.githubJobId)
      if (!annotated) {
        annotated = true
        await storeAnnotations(job)
      }
      await replaceWithGitHubLog(job, parseGitHubLog(text))
      return
    } catch (err) {
      const status = (err as { status?: number }).status
      const delay = retryDelays[attempt]
      if (delay === undefined) {
        logger.warn(`job ${job.id} (${job.repo}#${job.githubJobId}): GitHub log not available after ${attempt} tries, keeping the runner output`)
        break
      }
      logger.debug(`job ${job.id}: GitHub log ${status === 404 ? 'not ready yet' : `failed (${err instanceof Error ? err.message : String(err)})`}, retry in ${delay / 1000}s`)
      await sleep(delay)
    }
  }
  const fresh = await jobById(job.id)
  if (!fresh || fresh.logSource !== null) return
  await updateJob(job.id, { logSource: 'runner' }, undefined, { silent: true })
  bus.emit('log', { jobId: job.id, lines: [], done: true })
}

/** `2026-01-02T03:04:05.1234567Z text` (GitHub) → { at, line }; lines without a timestamp keep the previous one. */
export function parseGitHubLog(text: string): { at: string; line: string }[] {
  const out: { at: string; line: string }[] = []
  let last = new Date().toISOString()
  for (const line of text.split(/\r?\n/)) {
    // Each of GitHub's log files starts with a byte-order mark; the flat log can carry one per step.
    const raw = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line
    const i = raw.indexOf(' ')
    const ts = i > 0 ? raw.slice(0, i) : raw
    if (/^\d{4}-\d{2}-\d{2}T[^ ]+Z$/.test(ts)) {
      last = ts
      out.push({ at: ts, line: i > 0 ? raw.slice(i + 1) : '' })
    } else {
      out.push({ at: last, line: raw })
    }
  }
  while (out.length && out[out.length - 1]!.line === '') out.pop()
  return out
}

/** Stores `lines` (capped by `log_max_kb`) in place of the job's lines in one transaction and marks the source `github`. */
async function replaceWithGitHubLog(job: JobRow, lines: { at: string; line: string }[]): Promise<void> {
  const capKb = await settings.fetchInt('log_max_kb', 2048)
  const cap = capKb * KB
  const keep: { at: string; line: string }[] = []
  let bytes = 0
  let truncated = false
  for (const l of lines) {
    const size = byteLength(l.line)
    if (bytes + size > cap) {
      truncated = true
      keep.push({ at: l.at, line: TRUNCATED_NOTICE(capKb) })
      break
    }
    bytes += size
    keep.push(l)
  }
  await db().transaction(async (tx) => {
    await deleteLogLines(job.id, tx)
    // One statement per chunk keeps the parameter count under both dialects' limits.
    for (let i = 0; i < keep.length; i += 500) await appendLogLines(job.id, i + 1, keep.slice(i, i + 500), tx)
    await updateJob(job.id, { logSource: 'github', logBytes: bytes, logTruncated: truncated }, tx, { silent: true })
  })
  logger.info(`job ${job.id} (${job.repo}#${job.githubJobId}): stored GitHub log, ${keep.length} lines, ${Math.round(bytes / KB)} KB${truncated ? ', truncated' : ''}`)
  bus.emit('log', { jobId: job.id, lines: [], done: true, replaced: true })
}

import { backend } from './backends'
import { bus } from './bus'
import { config } from './config'
import { github } from './github/auth'
import { log } from './log'
import { settings } from './settings'
import { appendLogLines, deleteLogLines, jobById, jobsWithoutSteps, logCursor, updateJob, type JobRow, type RunnerRow } from './store'

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
  const job = await jobById(jobId)
  if (!job) return
  if (job.logSource !== null) return // already final (restart after completion)
  const cursor = await logCursor(jobId)
  let seq = cursor.seq
  let bytes = job.logBytes
  let truncated = job.logTruncated
  logger.info(`following ${runnerName} for job ${jobId}${cursor.at ? ` from seq ${cursor.seq}` : ''}`)

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
      if (truncated) return
      const out = await storeBatch(job, seq + 1, lines, bytes)
      seq += out.stored
      bytes = out.bytes
      truncated = out.truncated
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
  logger.info(`${runnerName} output ended for job ${jobId} (${seq} lines, ${Math.round(bytes / KB)} KB${truncated ? ', truncated' : ''})`)
  await finalise(job)
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

/** Replaces the live lines with GitHub's log; after the retry budget keeps them and marks the source `runner`. */
export async function finalise(job: JobRow): Promise<void> {
  await storeSteps(job)
  for (let attempt = 0; ; attempt++) {
    try {
      const text = await github().getJobLog(job.repo, job.githubJobId)
      await replaceWithGitHubLog(job, text)
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
  for (const raw of text.split(/\r?\n/)) {
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

async function replaceWithGitHubLog(job: JobRow, text: string): Promise<void> {
  const lines = parseGitHubLog(text)
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
  await deleteLogLines(job.id)
  // One statement per chunk keeps the parameter count under both dialects' limits.
  for (let i = 0; i < keep.length; i += 500) await appendLogLines(job.id, i + 1, keep.slice(i, i + 500))
  await updateJob(job.id, { logSource: 'github', logBytes: bytes, logTruncated: truncated }, undefined, { silent: true })
  logger.info(`job ${job.id} (${job.repo}#${job.githubJobId}): stored GitHub log, ${keep.length} lines, ${Math.round(bytes / KB)} KB${truncated ? ', truncated' : ''}`)
  bus.emit('log', { jobId: job.id, lines: [], done: true, replaced: true })
}

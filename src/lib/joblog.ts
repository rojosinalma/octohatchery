import { db } from '../db'
import { backend } from './backends'
import { bus } from './bus'
import { config } from './config'
import { github } from './github/auth'
import { MAX_ARCHIVE_BYTES, pickJobSteps } from './github/log-archive'
import type { JobDetails } from './github/types'
import { log } from './log'
import { settings } from './settings'
import { appendLogLines, deleteLogLines, jobById, jobsWithoutStepLines, jobsWithoutSteps, logLinesAfter, logCursor, runnerById, updateJob, type JobRow, type RunnerRow } from './store'

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

/**
 * GitHub hands out a run's log archive only once the whole run has finished, so the first job of a run to end gets a
 * 404; the sweep asks again after these waits (≈4 h in total), then this process gives up on the job.
 */
const DEFAULT_ARCHIVE_DELAYS_MS = [1, 2, 5, 10, 20, 30, 60, 120].map((m) => m * 60_000)
/**
 * Only jobs that ended this recently are backfilled from the archive: older rows keep the time-and-opener split
 * instead of every restart downloading a month of archives again.
 */
const ARCHIVE_BACKFILL_WINDOW_MS = 24 * 3600_000
/** Jobs tracked for a later archive try, at most; the oldest entry goes first. */
const ARCHIVE_TRIES_MAX = 2000

let retryDelays = DEFAULT_RETRY_DELAYS_MS
let flushMs = FLUSH_MS
let archiveDelays = DEFAULT_ARCHIVE_DELAYS_MS

/** Followers in flight on this node, by runner id; the promise settles when finalisation is done. */
const active = new Map<number, Promise<void>>()

/** Tests only: shorter waits and a clean follower table (followers of a closed database are abandoned). */
export function configureJobLog(opts: { retryDelaysMs?: number[]; flushMs?: number; archiveDelaysMs?: number[] } = {}): void {
  retryDelays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  flushMs = opts.flushMs ?? FLUSH_MS
  active.clear()
  backfilled.clear()
  archiveTries.clear()
  archiveDelays = opts.archiveDelaysMs ?? DEFAULT_ARCHIVE_DELAYS_MS
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
  if (final) await finalise(final)
}

/**
 * Asks GitHub for `job` and stores the steps it reports (authoritative timestamps, the webhook's copy may be older or
 * missing). A failure is logged and swallowed: steps are a reading aid, never a reason to lose the log. Returns the
 * details (they also locate the job in its run's log archive), or null when the call failed.
 */
async function fetchDetails(job: Pick<JobRow, 'id' | 'repo' | 'githubJobId'>): Promise<JobDetails | null> {
  try {
    const details = await github().getJob(job.repo, job.githubJobId)
    if (details.steps.length) {
      await updateJob(job.id, { steps: details.steps })
      logger.debug(`job ${job.id} (${job.repo}#${job.githubJobId}): stored ${details.steps.length} steps`)
    }
    return details
  } catch (err) {
    logger.warn(`job ${job.id} (${job.repo}#${job.githubJobId}): steps not fetched`, err instanceof Error ? err.message : String(err))
    return null
  }
}

/** Stores the steps GitHub reports for `job`; true when there were steps to store. */
export async function storeSteps(job: Pick<JobRow, 'id' | 'repo' | 'githubJobId'>): Promise<boolean> {
  return Boolean((await fetchDetails(job))?.steps.length)
}

export type StepLine = { at: string; line: string; step: number }

/**
 * The job's lines from GitHub's run-attempt archive, one file per step, each line carrying its step number. `flatLog`
 * (GitHub's job log, or the stored lines) settles which folder is the job's when its name does not. Null when the
 * archive is not available (404 while other jobs of the run still run, or expired), not readable or holds no folder
 * for the job: the reason is logged and the caller keeps the flat log and the timestamp split.
 */
export async function archiveLines(job: Pick<JobRow, 'id' | 'repo' | 'githubJobId'>, details: Pick<JobDetails, 'runId' | 'runAttempt' | 'name'>, flatLog?: string): Promise<{ lines: StepLine[] } | { lines: null; retry: boolean }> {
  const where = `job ${job.id} (${job.repo}#${job.githubJobId}, run ${details.runId} attempt ${details.runAttempt})`
  let zip: Uint8Array
  try {
    zip = await github().getRunAttemptLogs(job.repo, details.runId, details.runAttempt, MAX_ARCHIVE_BYTES)
  } catch (err) {
    const status = (err as { status?: number }).status
    logger.info(`${where}: step logs not available${status === 404 ? ' yet (the run is still going, or its logs expired)' : ''}: ${err instanceof Error ? err.message : String(err)}`)
    return { lines: null, retry: true }
  }
  const pick = pickJobSteps(zip, details.name, flatLog)
  if (!pick.ok) {
    // The same archive gives the same answer: not asked again by this process.
    logger.info(`${where}: step logs not used, the view splits the job log by time and step openers: ${pick.reason}`)
    return { lines: null, retry: false }
  }
  const lines = pick.steps.flatMap((s) => parseGitHubLog(s.text).map((l) => ({ ...l, step: s.number })))
  if (!lines.length) {
    logger.info(`${where}: folder "${pick.folder}" holds no lines, the view splits the job log by time and step openers`)
    return { lines: null, retry: false }
  }
  logger.debug(`${where}: ${lines.length} lines in ${pick.steps.length} step files of "${pick.folder}"`)
  return { lines }
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

/** Jobs waiting for their run's archive: when to ask next, how often it was asked, where the job sits in the run. */
const archiveTries = new Map<number, { tries: number; nextAt: number; details: Pick<JobDetails, 'runId' | 'runAttempt' | 'name'> | null }>()

/** Schedules the next archive try for `jobId`; `retry: false` or used-up waits leave the job alone for this process. */
function scheduleArchiveTry(jobId: number, details: Pick<JobDetails, 'runId' | 'runAttempt' | 'name'> | null, nowMs = Date.now(), retry = true): void {
  const tries = (archiveTries.get(jobId)?.tries ?? 0) + 1
  const delay = retry ? archiveDelays[tries - 1] : undefined
  archiveTries.delete(jobId)
  if (delay === undefined) {
    archiveTries.set(jobId, { tries, nextAt: Number.POSITIVE_INFINITY, details })
    return
  }
  archiveTries.set(jobId, { tries, nextAt: nowMs + delay, details })
  while (archiveTries.size > ARCHIVE_TRIES_MAX) archiveTries.delete(archiveTries.keys().next().value!)
}

/** A stored log as text again, one line per row: what the archive's folders are compared with. */
async function storedText(jobId: number): Promise<string> {
  const out: string[] = []
  for (let after = 0; ; ) {
    const page = await logLinesAfter(jobId, after, 5000)
    if (!page.length) break
    for (const l of page) out.push(l.line)
    after = page[page.length - 1]!.seq
  }
  return out.join('\n')
}

/**
 * Jobs that ended in the last 24 hours and whose stored GitHub log has no step numbers yet: fetches the run's
 * archive and replaces the lines with the per-step ones (annotations too when none are stored). At most `max` jobs
 * per pass; a job whose archive is not there yet (404 while other jobs of the run still run) is asked again after the
 * archive waits; one whose archive holds no step files for it is left alone by this process.
 */
export async function backfillStepLines(max = 5, nowMs = Date.now()): Promise<number> {
  let n = 0
  let tried = 0
  for (const job of await jobsWithoutStepLines(max + archiveTries.size, new Date(nowMs - ARCHIVE_BACKFILL_WINDOW_MS).toISOString())) {
    if (tried >= max) break
    const seen = archiveTries.get(job.id)
    if (seen && seen.nextAt > nowMs) continue
    tried++
    const details = seen?.details ?? (await fetchDetails(job))
    if (!details) {
      scheduleArchiveTry(job.id, null, nowMs)
      continue
    }
    const out = await archiveLines(job, details, await storedText(job.id))
    if (!out.lines) {
      scheduleArchiveTry(job.id, details, nowMs, out.retry)
      continue
    }
    archiveTries.delete(job.id)
    if (!job.annotations.length) await storeAnnotations(job)
    const fresh = await jobById(job.id)
    if (fresh) await replaceWithGitHubLog(fresh, out.lines)
    n++
  }
  if (n) logger.info(`backfilled step logs for ${n} job(s)`)
  return n
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

/**
 * Replaces the live lines with GitHub's log: the per-step files of the run's archive when GitHub hands them out (each
 * line knows its step), else the job's flat log (the view splits it by timestamp). After the retry budget the live
 * lines stay and the source is marked `runner`.
 */
export async function finalise(job: JobRow): Promise<void> {
  const details = await fetchDetails(job)
  /** Per-step lines, fetched once the flat log is there (it settles an ambiguous folder); null = not available. */
  let stepped: StepLine[] | null | undefined
  for (let attempt = 0; ; attempt++) {
    try {
      const text = await github().getJobLog(job.repo, job.githubJobId)
      if (stepped === undefined) {
        const out = details ? await archiveLines(job, details, text) : { lines: null, retry: true }
        stepped = out.lines
        if (!out.lines) scheduleArchiveTry(job.id, details, Date.now(), out.retry)
        await storeAnnotations(job)
      }
      await replaceWithGitHubLog(job, stepped ?? parseGitHubLog(text))
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
async function replaceWithGitHubLog(job: JobRow, lines: { at: string; line: string; step?: number }[]): Promise<void> {
  const capKb = await settings.fetchInt('log_max_kb', 2048)
  const cap = capKb * KB
  const keep: { at: string; line: string; step?: number }[] = []
  let bytes = 0
  let truncated = false
  for (const l of lines) {
    const size = byteLength(l.line)
    if (bytes + size > cap) {
      truncated = true
      keep.push({ at: l.at, line: TRUNCATED_NOTICE(capKb), step: l.step })
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
  const steps = new Set(keep.map((l) => l.step).filter((n) => n !== undefined)).size
  logger.info(`job ${job.id} (${job.repo}#${job.githubJobId}): stored GitHub log, ${keep.length} lines${steps ? ` in ${steps} step files` : ' (flat)'}, ${Math.round(bytes / KB)} KB${truncated ? ', truncated' : ''}`)
  bus.emit('log', { jobId: job.id, lines: [], done: true, replaced: true })
}

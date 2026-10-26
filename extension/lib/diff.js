// Change detection between two polls. The worker keeps a small snapshot (status and conclusion per job it
// saw last time) and compares the next poll with it. Pure: no browser APIs, no clock.

/** Statuses the server counts as running (its `running` filter). */
export const RUNNING = new Set(['claimed', 'in_progress'])
/** Conclusions the server counts as failed (its `failed` filter). */
export const FAILED = new Set(['failure', 'timed_out', 'cancelled'])
/** Jobs kept in the snapshot at most; the newest win. */
export const KNOWN_MAX = 400
/** A running job that is missing from a poll (and its own fetch) is dropped after this many polls. */
export const MISS_MAX = 5

/**
 * @typedef {{ id: number, repo: string, name: string, status: string, conclusion: string | null,
 *   runnerId: number | null, htmlUrl: string, queuedAt: string, startedAt: string | null, completedAt: string | null,
 *   labels?: string[] }} Job
 * @typedef {{ s: string, c: string | null, miss?: number }} Seen
 * @typedef {{ base: string, maxId: number, known: Record<string, Seen> }} Snapshot
 * @typedef {'started' | 'succeeded' | 'failed'} EventKind
 * @typedef {{ kind: EventKind, job: Job }} JobEvent
 */

/**
 * What a conclusion counts as. Anything but success or a failure (skipped, neutral, unknown, none yet)
 * counts as nothing: the result is never guessed.
 * @param {string | null | undefined} conclusion
 * @returns {'succeeded' | 'failed' | null}
 */
export function outcome(conclusion) {
  if (conclusion === 'success') return 'succeeded'
  if (conclusion && FAILED.has(conclusion)) return 'failed'
  return null
}

/**
 * Ids of jobs that were running in the snapshot but are not in this poll: the worker fetches each one
 * on its own, so a long job that dropped off the recent page still reports how it ended.
 * @param {Snapshot | null} prev
 * @param {Job[]} jobs
 * @returns {number[]}
 */
export function missingRunning(prev, jobs) {
  if (!prev) return []
  const have = new Set(jobs.map((j) => j.id))
  return Object.entries(prev.known)
    .filter(([id, seen]) => RUNNING.has(seen.s) && !have.has(Number(id)))
    .map(([id]) => Number(id))
}

/**
 * Compares a poll with the last snapshot.
 * - No snapshot (first poll, or a new hatchery URL): only records a baseline, no events.
 * - `started`: a job is running now and was not running (or not seen) before. A new job that started and
 *   ended between two polls reports `started` too, then its result.
 * - `succeeded` / `failed`: a job is completed now with that result and was not completed before; or it was
 *   completed with an unknown result that is known now.
 * @param {Snapshot | null} prev
 * @param {Job[]} jobs this poll, every job once (running, queued, recent and the ones fetched by id)
 * @param {string} base the hatchery origin the poll came from
 * @param {number[]} [gone] ids fetched by id that the server no longer has
 * @returns {{ events: JobEvent[], snapshot: Snapshot }}
 */
export function detect(prev, jobs, base, gone = []) {
  const usable = prev && prev.base === base ? prev : null
  /** @type {JobEvent[]} */
  const events = []
  /** @type {Record<string, Seen>} */
  const known = {}
  let maxId = usable?.maxId ?? 0
  const byId = [...jobs].sort((a, b) => a.id - b.id)

  for (const job of byId) {
    known[job.id] = { s: job.status, c: job.conclusion ?? null }
    if (!usable) continue
    const p = usable.known[job.id]
    const isNew = !p && job.id > usable.maxId
    const wasRunning = !!p && RUNNING.has(p.s)
    const wasDone = !!p && p.s === 'completed'

    if (RUNNING.has(job.status)) {
      if (!wasRunning && !wasDone) events.push({ kind: 'started', job })
      continue
    }
    if (job.status !== 'completed') continue
    const result = outcome(job.conclusion)
    if (isNew || (p && !wasDone)) {
      if (!wasRunning && job.startedAt) events.push({ kind: 'started', job })
      if (result) events.push({ kind: result, job })
    } else if (wasDone && !outcome(p.c) && result) {
      events.push({ kind: result, job })
    }
  }
  for (const job of byId) maxId = Math.max(maxId, job.id)

  // A running job this poll did not see stays known for a few polls, so its end still counts when it shows again.
  if (usable) {
    const skip = new Set(gone)
    for (const [id, seen] of Object.entries(usable.known)) {
      if (id in known || skip.has(Number(id)) || !RUNNING.has(seen.s)) continue
      const miss = (seen.miss ?? 0) + 1
      if (miss <= MISS_MAX) known[id] = { ...seen, miss }
    }
  }

  const ids = Object.keys(known).map(Number).sort((a, b) => b - a)
  for (const id of ids.slice(KNOWN_MAX)) delete known[id]
  return { events, snapshot: { base, maxId, known } }
}

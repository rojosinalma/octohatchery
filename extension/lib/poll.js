// One poll of the hatchery: fetches what the popup and the toolbar need, compares it with the last
// snapshot and returns the new view, the events and the next snapshot. No storage, no notifications:
// the worker does those with the result.

import { getJson } from './api.js'
import { detect, missingRunning, RUNNING } from './diff.js'

/** Jobs fetched by id per poll at most (running jobs that dropped off the recent page). */
export const BY_ID_MAX = 20
export const RECENT_SHOWN = 8
export const QUEUED_SHOWN = 5

/**
 * @typedef {import('./diff.js').Job} Job
 * @typedef {import('./diff.js').Snapshot} Snapshot
 * @typedef {Job & { runner: { name: string, host: string, type: string } | null }} ViewJob
 * @typedef {{ name: string, status: string, dockerOk: boolean, isLeader: boolean, used: number, count: number }} ViewHost
 * @typedef {{ at: number, version: string, running: ViewJob[], queued: { total: number, jobs: ViewJob[] }, recent: ViewJob[], hosts: ViewHost[] }} View
 * @typedef {{ status: 'ok', view: View, events: import('./diff.js').JobEvent[], snapshot: Snapshot, runners: Map<number, { name: string, host: string, type: string }> }
 *   | { status: 'signed_out' | 'down', message: string }} PollResult
 */

/** @param {any} j @returns {Job} the fields the extension uses (no steps, no annotations) */
export const slim = (j) => ({
  id: j.id,
  repo: j.repo,
  name: j.name,
  status: j.status,
  conclusion: j.conclusion ?? null,
  runnerId: j.runnerId ?? null,
  htmlUrl: j.htmlUrl,
  queuedAt: j.queuedAt,
  startedAt: j.startedAt ?? null,
  completedAt: j.completedAt ?? null,
  labels: Array.isArray(j.labels) ? j.labels : [],
})

/**
 * @param {string} base
 * @param {Snapshot | null} prev
 * @param {{ fetchImpl?: typeof fetch, now?: number }} [opts]
 * @returns {Promise<PollResult>}
 */
export async function pollOnce(base, prev, opts = {}) {
  const get = (/** @type {string} */ path) => getJson(base, path, opts)
  const results = await Promise.all([
    get('/api/jobs?running=true&limit=100'),
    get('/api/jobs?limit=50'),
    get('/api/jobs?status=queued&limit=20'),
    get('/api/runners?limit=200'),
    get('/api/hosts'),
    get('/api/slots'),
    get('/health'),
  ])
  const signedOut = results.find((r) => r.kind === 'signed_out')
  if (signedOut) return { status: 'signed_out', message: 'the proxy asks for a sign-in' }
  const failed = results.find((r) => r.kind !== 'ok')
  if (failed) return { status: 'down', message: 'message' in failed ? failed.message : 'no answer' }
  const [running, recent, queued, runners, hosts, slots, health] = results.map((r) => /** @type {any} */ (r).data)

  /** @type {Map<number, Job>} */
  const jobs = new Map()
  for (const j of [...recent.jobs, ...queued.jobs, ...running.jobs]) jobs.set(j.id, slim(j))

  /** @type {number[]} */
  const gone = []
  const missing = missingRunning(prev && prev.base === base ? prev : null, [...jobs.values()]).slice(0, BY_ID_MAX)
  const byId = await Promise.all(missing.map((id) => get(`/api/jobs/${id}`)))
  byId.forEach((r, i) => {
    if (r.kind === 'ok' && r.data.job) jobs.set(r.data.job.id, slim(r.data.job))
    else if (r.kind === 'missing') gone.push(/** @type {number} */ (missing[i]))
  })

  const { events, snapshot } = detect(prev, [...jobs.values()], base, gone)

  /** @type {Map<number, { name: string, host: string, type: string }>} */
  const runnerById = new Map(runners.runners.map((/** @type {any} */ r) => [r.id, { name: r.name, host: r.host, type: r.type }]))
  const withRunner = (/** @type {Job} */ j) => ({ ...j, runner: (j.runnerId !== null && runnerById.get(j.runnerId)) || null })

  /** @type {Map<string, { used: number, count: number }>} */
  const perHost = new Map()
  for (const s of slots.slots) {
    const cur = perHost.get(s.host) ?? { used: 0, count: 0 }
    perHost.set(s.host, { used: cur.used + s.used, count: cur.count + s.count })
  }

  const runningJobs = running.jobs.map(slim).filter((/** @type {Job} */ j) => RUNNING.has(j.status))
  runningJobs.sort((/** @type {Job} */ a, /** @type {Job} */ b) => Date.parse(a.startedAt ?? a.queuedAt) - Date.parse(b.startedAt ?? b.queuedAt))
  /** @type {View} */
  const view = {
    at: opts.now ?? Date.now(),
    version: String(health.version ?? ''),
    running: runningJobs.map(withRunner),
    queued: { total: Number(queued.total ?? queued.jobs.length), jobs: queued.jobs.map(slim).reverse().slice(0, QUEUED_SHOWN).map(withRunner) },
    recent: recent.jobs.map(slim).filter((/** @type {Job} */ j) => j.status === 'completed').slice(0, RECENT_SHOWN).map(withRunner),
    hosts: hosts.hosts.map((/** @type {any} */ h) => ({
      name: h.name,
      status: h.status,
      dockerOk: h.dockerOk !== false,
      isLeader: !!h.isLeader,
      ...(perHost.get(h.name) ?? { used: 0, count: 0 }),
    })),
  }
  return { status: 'ok', view, events, snapshot, runners: runnerById }
}

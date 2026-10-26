// Turns a poll's events into browser notifications: the kinds the settings turn on, for the repos the filter
// keeps; more than GROUP_AT of one kind in a poll become one summary notification. Pure.

import { durationText } from './format.js'

export const GROUP_AT = 4

/** @typedef {import('./diff.js').JobEvent} JobEvent */
/** @typedef {{ name: string, host: string, type: string }} RunnerInfo */
/** @typedef {{ id: string, title: string, message: string, path: string }} Alert */

const WORD = { started: 'Started', succeeded: 'Succeeded', failed: 'Failed' }
const SETTING = /** @type {const} */ ({ started: 'alertStarted', succeeded: 'alertSucceeded', failed: 'alertFailed' })
/** Where a summary notification leads. */
const LIST_PATH = { started: '/jobs?running=1', succeeded: '/jobs?status=completed', failed: '/jobs?failed=1' }

/**
 * The events the counters and alerts use: a cancelled job counts as failed only when the setting says so.
 * @param {import('./settings.js').Settings} settings
 * @param {JobEvent[]} events
 */
export function countedEvents(settings, events) {
  return settings.cancelledAsFailed ? events : events.filter((e) => !(e.kind === 'failed' && e.job.conclusion === 'cancelled'))
}

/**
 * @param {import('./settings.js').Settings} settings
 * @param {JobEvent[]} events (already passed through countedEvents)
 * @param {Map<number, RunnerInfo>} runners runner id → where it runs
 * @param {number} now epoch ms
 * @returns {Alert[]}
 */
export function buildAlerts(settings, events, runners, now) {
  const repos = new Set(settings.alertRepos)
  const keep = events.filter((e) => settings[SETTING[e.kind]] && (repos.size === 0 || repos.has(e.job.repo)))
  /** @type {Alert[]} */
  const out = []
  for (const kind of /** @type {const} */ (['failed', 'succeeded', 'started'])) {
    const list = keep.filter((e) => e.kind === kind)
    if (!list.length) continue
    if (list.length >= GROUP_AT) {
      const names = list.slice(0, 3).map((e) => `${e.job.name} (${shortRepo(e.job.repo)})`)
      const more = list.length > 3 ? `, and ${list.length - 3} more` : ''
      out.push({ id: `oh:list:${kind}:${now}`, title: `${list.length} jobs ${WORD[kind].toLowerCase()}`, message: names.join(', ') + more, path: LIST_PATH[kind] })
      continue
    }
    for (const { job } of list) {
      const runner = job.runnerId === null ? undefined : runners.get(job.runnerId)
      const where = runner ? `${runner.host} · ${runner.type}` : null
      const took = kind !== 'started' && job.startedAt && job.completedAt ? durationText(Date.parse(job.completedAt) - Date.parse(job.startedAt)) : null
      const result = kind === 'failed' && job.conclusion && job.conclusion !== 'failure' ? job.conclusion.replace('_', ' ') : null
      const message = [job.repo, where, took && `took ${took}`, result].filter(Boolean).join(' · ')
      out.push({ id: `oh:job:${kind}:${job.id}`, title: `${WORD[kind]}: ${job.name}`, message, path: `/jobs/${job.id}` })
    }
  }
  return out
}

/** `owner/name` → `name`. @param {string} repo */
export const shortRepo = (repo) => repo.slice(repo.indexOf('/') + 1)

/**
 * The dashboard path a notification id leads to; null for ids this extension did not create.
 * @param {string} id
 */
export function alertPath(id) {
  const m = /^oh:(job|list):(started|succeeded|failed):(\d+)$/.exec(id)
  if (!m) return id === 'oh:test' ? '/' : null
  const kind = /** @type {'started' | 'succeeded' | 'failed'} */ (m[2])
  return m[1] === 'job' ? `/jobs/${m[3]}` : LIST_PATH[kind]
}

// Toolbar counters: what the badge or the drawn icon shows, from the settings, the live running count and the
// counts since the popup was last opened. Pure.

/** Gruvbox hues (the logo palette): standalone toolbar art has no CSS cascade, so the colours are literal. */
export const COLORS = Object.freeze({
  running: '#83a598',
  started: '#8ec07c',
  succeeded: '#b8bb26',
  failed: '#fb4934',
  warning: '#fe8019',
  muted: '#928374',
  plate: '#282828',
  ink: '#282828',
})

/** @typedef {{ started: number, succeeded: number, failed: number }} Unseen */
/** @typedef {'running' | 'started' | 'succeeded' | 'failed'} CellKey */
/** @typedef {{ key: CellKey, value: number }} Cell */
/** @typedef {'ok' | 'unconfigured' | 'no_permission' | 'signed_out' | 'down'} Status */

/** @returns {Unseen} */
export const zeroUnseen = () => ({ started: 0, succeeded: 0, failed: 0 })

/**
 * Adds a poll's events to the counts since the popup was last opened.
 * @param {Unseen} unseen
 * @param {{ kind: keyof Unseen }[]} events
 * @returns {Unseen}
 */
export function addEvents(unseen, events) {
  const next = { ...zeroUnseen(), ...unseen }
  for (const e of events) next[e.kind] += 1
  return next
}

/**
 * The counters the settings turn on, in a fixed order (running, started, succeeded, failed).
 * @param {import('./settings.js').Settings} settings
 * @param {number} running live running count
 * @param {Unseen} unseen
 * @returns {Cell[]}
 */
export function cells(settings, running, unseen) {
  /** @type {Cell[]} */
  const out = []
  const mode = settings.counterRunning
  if (mode === 'live' || mode === 'both') out.push({ key: 'running', value: running })
  if (mode === 'started' || mode === 'both') out.push({ key: 'started', value: unseen.started })
  if (settings.counterSucceeded) out.push({ key: 'succeeded', value: unseen.succeeded })
  if (settings.counterFailed) out.push({ key: 'failed', value: unseen.failed })
  return out
}

/** Badge priority: a failure first, then a success, then what is running. */
const PRIORITY = /** @type {const} */ (['failed', 'succeeded', 'running', 'started'])

/** Short count text: up to two characters on the icon, three on the badge. @param {number} n @param {number} width */
export function countText(n, width) {
  if (width <= 2) return n > 9 ? '9+' : String(n)
  return n > 99 ? '99+' : String(n)
}

const LABELS = { running: 'running', started: 'started', succeeded: 'succeeded', failed: 'failed' }
const STATUS_TEXT = {
  unconfigured: 'Set the hatchery URL in the options',
  no_permission: 'Allow access to the hatchery in the options',
  signed_out: 'Signed out: open the hatchery and sign in',
  down: 'The hatchery does not answer',
}

/**
 * What the toolbar shows.
 * - `icon` style: `draw` holds the non-zero cells for the drawn icon; no badge.
 * - `badge` style: the default icon and one badge, picked by priority.
 * - Any status but `ok`: the default icon and a `!` (or `?` when no URL is set) badge, whatever the style.
 * @param {import('./settings.js').Settings} settings
 * @param {{ status: Status, running: number, queued: number, unseen: Unseen, message?: string }} state
 * @returns {{ draw: Cell[] | null, badge: { text: string, color: string }, title: string }}
 */
export function toolbarPlan(settings, state) {
  const list = cells(settings, state.running, state.unseen)
  const summary = list.map((c) => `${c.value} ${LABELS[c.key]}`)
  if (state.queued > 0) summary.push(`${state.queued} queued`)
  const sinceOpen = settings.resetOnOpen ? ' (succeeded, failed and started: since the popup was last opened)' : ''
  const title = `OctoHatchery: ${summary.length ? summary.join(', ') : 'no counters on'}${list.some((c) => c.key !== 'running') ? sinceOpen : ''}`

  if (state.status !== 'ok') {
    const text = state.status === 'unconfigured' ? '?' : '!'
    const color = state.status === 'unconfigured' ? COLORS.muted : COLORS.warning
    const why = state.message ? `${STATUS_TEXT[state.status]} (${state.message})` : STATUS_TEXT[state.status]
    return { draw: null, badge: { text, color }, title: `OctoHatchery: ${why}` }
  }
  const lit = list.filter((c) => c.value > 0)
  if (settings.badgeStyle === 'icon') return { draw: lit.length ? lit : null, badge: { text: '', color: COLORS.muted }, title }
  for (const key of PRIORITY) {
    const c = lit.find((x) => x.key === key)
    if (c) return { draw: null, badge: { text: countText(c.value, 3), color: COLORS[key] }, title }
  }
  return { draw: null, badge: { text: '', color: COLORS.muted }, title }
}

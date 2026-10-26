// Extension settings: one flat record in `storage.sync`, normalised on every read so a missing,
// older or hand-edited record never breaks the worker. Pure except `loadSettings` / `saveSetting`.

/** What the running counter shows: the live count, jobs started since the popup was last opened, both, or nothing. */
export const RUNNING_MODES = /** @type {const} */ (['live', 'started', 'both', 'off'])
/** `icon` draws every counter on the toolbar icon; `badge` shows the most important one as a badge. */
export const BADGE_STYLES = /** @type {const} */ (['icon', 'badge'])
/** Browsers fire alarms at most every 30 s, so a shorter poll is not possible. */
export const MIN_POLL_S = 30
export const MAX_POLL_S = 3600

/**
 * @typedef {{
 *   url: string,
 *   pollSeconds: number,
 *   alertsEnabled: boolean,
 *   alertStarted: boolean,
 *   alertSucceeded: boolean,
 *   alertFailed: boolean,
 *   alertRepos: string[],
 *   cancelledAsFailed: boolean,
 *   counterRunning: 'live' | 'started' | 'both' | 'off',
 *   counterSucceeded: boolean,
 *   counterFailed: boolean,
 *   resetOnOpen: boolean,
 *   badgeStyle: 'icon' | 'badge',
 *   themeFromHatchery: boolean,
 * }} Settings
 */

/** @type {Readonly<Settings>} */
export const DEFAULTS = Object.freeze({
  url: '',
  pollSeconds: 60,
  alertsEnabled: true,
  alertStarted: true,
  alertSucceeded: true,
  alertFailed: true,
  alertRepos: [],
  cancelledAsFailed: true,
  counterRunning: 'live',
  counterSucceeded: true,
  counterFailed: true,
  resetOnOpen: true,
  badgeStyle: 'icon',
  themeFromHatchery: true,
})

const BOOLEAN_KEYS = ['alertsEnabled', 'alertStarted', 'alertSucceeded', 'alertFailed', 'cancelledAsFailed', 'counterSucceeded', 'counterFailed', 'resetOnOpen', 'themeFromHatchery']

/**
 * The origin of a hatchery URL (`https://host[:port]`), or null when it is not an http(s) URL.
 * A missing scheme means https. Paths are dropped: the dashboard links are absolute, so it runs at the site root.
 * @param {unknown} input
 * @returns {string | null}
 */
export function normalizeUrl(input) {
  let s = String(input ?? '').trim()
  if (!s) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`
  let u
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password || !u.hostname) return null
  return u.origin
}

/** The host permission pattern for a hatchery origin. @param {string} origin */
export const originPattern = (origin) => `${origin}/*`

/**
 * Every key present with a valid value; anything else falls back to its default.
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {Settings}
 */
export function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  /** @type {Settings} */
  const s = { ...DEFAULTS, alertRepos: [] }
  if (typeof r.url === 'string') s.url = normalizeUrl(r.url) ?? ''
  const poll = Number(r.pollSeconds)
  if (Number.isFinite(poll) && poll > 0) s.pollSeconds = Math.min(MAX_POLL_S, Math.max(MIN_POLL_S, Math.round(poll)))
  for (const k of BOOLEAN_KEYS) if (typeof r[k] === 'boolean') /** @type {any} */ (s)[k] = r[k]
  if (Array.isArray(r.alertRepos)) s.alertRepos = [...new Set(r.alertRepos.filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 200))]
  if (RUNNING_MODES.includes(/** @type {any} */ (r.counterRunning))) s.counterRunning = /** @type {any} */ (r.counterRunning)
  if (BADGE_STYLES.includes(/** @type {any} */ (r.badgeStyle))) s.badgeStyle = /** @type {any} */ (r.badgeStyle)
  return s
}

/**
 * One setting from the options page, checked against the same rules as a stored record.
 * @param {string} key
 * @param {unknown} value
 * @returns {{ ok: true, value: unknown } | { ok: false, message: string }}
 */
export function checkSetting(key, value) {
  if (!(key in DEFAULTS)) return { ok: false, message: `unknown setting ${key}` }
  if (key === 'pollSeconds') {
    const n = Number(value)
    if (!Number.isFinite(n) || n < MIN_POLL_S) return { ok: false, message: `The poll interval must be ${MIN_POLL_S} s or more` }
    if (n > MAX_POLL_S) return { ok: false, message: `The poll interval must be ${MAX_POLL_S / 60} min or less` }
    return { ok: true, value: Math.round(n) }
  }
  if (key === 'url') {
    if (value === '') return { ok: true, value: '' }
    const url = normalizeUrl(value)
    return url ? { ok: true, value: url } : { ok: false, message: 'This is not an http or https URL' }
  }
  const out = /** @type {any} */ (normalizeSettings({ [key]: value }))[key]
  if (key === 'alertRepos') return Array.isArray(value) ? { ok: true, value: out } : { ok: false, message: 'The repo filter must be a list' }
  if (out !== value) return { ok: false, message: `Not a valid value for ${key}` }
  return { ok: true, value: out }
}

/** @param {{ get(keys: null): Promise<Record<string, unknown>> }} area */
export async function loadSettings(area) {
  return normalizeSettings(await area.get(null))
}

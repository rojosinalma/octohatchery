// Background worker (Chrome service worker, Firefox event page). Polls the hatchery on an alarm, compares
// with the last poll, keeps the counters, sends the alerts and paints the toolbar. The popup connects a
// port named `popup` while it is open: that resets the counters (when the setting is on) and asks for
// fresh polls when the live stream reports a change.

import { alertPath, buildAlerts, countedEvents } from './lib/alerts.js'
import { ext } from './lib/browser.js'
import { addEvents, toolbarPlan, zeroUnseen } from './lib/counters.js'
import { drawCounters } from './lib/icon.js'
import { pollOnce } from './lib/poll.js'
import { loadSettings, originPattern } from './lib/settings.js'

const ALARM = 'poll'
const ICON = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' }
const NOTE_ICON = 'icons/icon-128.png'
/** @type {Set<any>} */
const ports = new Set()

/** @typedef {{ status: import('./lib/counters.js').Status, message?: string, at: number, base: string, view: import('./lib/poll.js').View | null }} State */

const local = {
  /** @returns {Promise<{ state?: State, snapshot?: any, unseen?: import('./lib/counters.js').Unseen }>} */
  get: () => ext.storage.local.get(['state', 'snapshot', 'unseen']),
  /** @param {Record<string, unknown>} v */
  set: (v) => ext.storage.local.set(v),
}

async function schedule() {
  const s = await loadSettings(ext.storage.sync)
  await ext.alarms.clear(ALARM)
  if (s.url) await ext.alarms.create(ALARM, { delayInMinutes: s.pollSeconds / 60, periodInMinutes: s.pollSeconds / 60 })
}

/** One poll at a time; a request during a poll runs one more right after it. */
let current = /** @type {Promise<void> | null} */ (null)
let again = false
function poll() {
  if (current) {
    again = true
    return current
  }
  current = doPoll()
    .catch((err) => console.error('poll failed', err))
    .finally(() => {
      current = null
      if (again) {
        again = false
        void poll()
      }
    })
  return current
}

async function doPoll() {
  const s = await loadSettings(ext.storage.sync)
  const { state: prev, snapshot, unseen = zeroUnseen() } = await local.get()
  const keepView = prev && prev.base === s.url ? prev.view : null
  if (!s.url) return save({ status: 'unconfigured', at: Date.now(), base: '', view: null })
  if (!(await ext.permissions.contains({ origins: [originPattern(s.url)] }))) {
    return save({ status: 'no_permission', at: Date.now(), base: s.url, view: keepView })
  }
  const r = await pollOnce(s.url, snapshot ?? null)
  if (r.status !== 'ok') return save({ status: r.status, message: r.message, at: Date.now(), base: s.url, view: keepView })

  const events = countedEvents(s, r.events)
  const quiet = s.resetOnOpen && ports.size > 0
  await local.set({ snapshot: r.snapshot, unseen: quiet ? zeroUnseen() : addEvents(unseen, events) })
  await save({ status: 'ok', at: r.view.at, base: s.url, view: r.view })
  for (const a of buildAlerts(s, events, r.runners, Date.now())) {
    await ext.notifications.create(a.id, { type: 'basic', iconUrl: NOTE_ICON, title: a.title, message: a.message || ' ' }).catch(() => {})
  }
}

/** @param {State} state */
async function save(state) {
  await local.set({ state })
  await paint()
}

/** @param {number} size */
function render(size, /** @type {import('./lib/counters.js').Cell[]} */ lit) {
  const canvas = new OffscreenCanvas(size, size)
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'))
  drawCounters(ctx, size, lit)
  return ctx.getImageData(0, 0, size, size)
}

async function paint() {
  const s = await loadSettings(ext.storage.sync)
  const { state, unseen = zeroUnseen() } = await local.get()
  const status = state?.status ?? (s.url ? 'ok' : 'unconfigured')
  const view = state?.view ?? null
  const plan = toolbarPlan(s, { status, message: state?.message, running: view?.running.length ?? 0, queued: view?.queued.total ?? 0, unseen })
  await ext.action.setTitle({ title: plan.title })
  await ext.action.setBadgeText({ text: plan.badge.text })
  await ext.action.setBadgeBackgroundColor({ color: plan.badge.color })
  if (ext.action.setBadgeTextColor) await ext.action.setBadgeTextColor({ color: '#282828' })
  if (plan.draw) await ext.action.setIcon({ imageData: { 16: render(16, plan.draw), 32: render(32, plan.draw) } })
  else await ext.action.setIcon({ path: ICON })
}

ext.runtime.onInstalled.addListener(() => void schedule().then(poll))
ext.runtime.onStartup.addListener(() => void schedule().then(poll))
ext.alarms.onAlarm.addListener((/** @type {{ name: string }} */ a) => {
  if (a.name === ALARM) void poll()
})

ext.storage.onChanged.addListener((/** @type {Record<string, { oldValue?: unknown, newValue?: unknown }>} */ changes, /** @type {string} */ area) => {
  if (area !== 'sync') return
  if ('url' in changes) {
    // A new hatchery: start a new baseline and new counters.
    void ext.storage.local.remove(['snapshot', 'state', 'unseen']).then(schedule).then(poll)
  } else if ('pollSeconds' in changes) {
    void schedule()
  } else {
    void paint()
  }
})

ext.runtime.onConnect.addListener((/** @type {any} */ port) => {
  if (port.name !== 'popup') return
  ports.add(port)
  port.onDisconnect.addListener(() => ports.delete(port))
  port.onMessage.addListener((/** @type {{ type?: string }} */ m) => {
    if (m?.type === 'refresh') void poll()
  })
  void (async () => {
    const s = await loadSettings(ext.storage.sync)
    const { unseen = zeroUnseen() } = await local.get()
    port.postMessage({ type: 'opened', unseen })
    if (s.resetOnOpen) {
      await local.set({ unseen: zeroUnseen() })
      await paint()
    }
    void poll()
  })()
})

ext.runtime.onMessage.addListener((/** @type {{ type?: string }} */ m) => {
  if (m?.type === 'poll') void poll()
  if (m?.type === 'reset') void local.set({ unseen: zeroUnseen() }).then(paint)
})

// Access granted or taken back on the options page, the popup or chrome://extensions: poll at once.
ext.permissions.onAdded.addListener(() => void poll())
ext.permissions.onRemoved.addListener(() => void poll())

ext.notifications.onClicked.addListener(async (/** @type {string} */ id) => {
  const path = alertPath(id)
  if (path === null) return
  const s = await loadSettings(ext.storage.sync)
  if (s.url) await ext.tabs.create({ url: s.url + path })
  await ext.notifications.clear(id)
})

// A worker that woke for any reason checks that the poll alarm exists (it is lost when the extension is reloaded).
void ext.alarms.get(ALARM).then((/** @type {unknown} */ a) => {
  if (!a) void schedule().then(poll)
})

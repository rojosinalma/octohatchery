// Popup: the last poll from storage at once, then live. While open it holds a port to the worker (which
// resets the counters when the setting is on) and follows the hatchery's event stream; every job, runner or
// slot event asks the worker for a fresh poll, and the new state arrives through storage.

import { shortRepo } from './lib/alerts.js'
import { ext } from './lib/browser.js'
import { zeroUnseen } from './lib/counters.js'
import { agoText, durationText } from './lib/format.js'
import { loadSettings, originPattern } from './lib/settings.js'
import { $, esc, followTheme, icon } from './ui.js'

/** @typedef {import('./lib/poll.js').View} View */
/** @typedef {import('./lib/poll.js').ViewJob} ViewJob */

let settings = await loadSettings(ext.storage.sync)
/** @type {any} */
let state = null
/** Counts since the popup was last opened, as they were when it opened (the worker resets them then). */
let opened = zeroUnseen()
let unseen = zeroUnseen()

const base = () => settings.url

/** Opens a dashboard path in a new tab and closes the popup. @param {string} url */
async function openTab(url) {
  await ext.tabs.create({ url })
  window.close()
}

document.addEventListener('click', (e) => {
  const el = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-open], [data-href]'))
  if (!el) return
  e.preventDefault()
  e.stopPropagation()
  if (el.dataset.href) void openTab(el.dataset.href)
  else if (base()) void openTab(base() + el.dataset.open)
  else void ext.runtime.openOptionsPage()
})
$('#options').addEventListener('click', () => void ext.runtime.openOptionsPage().then(() => window.close()))
$('#refresh').addEventListener('click', () => {
  $('#refresh').setAttribute('aria-busy', 'true')
  port?.postMessage({ type: 'refresh' })
})

// ── port to the worker ───────────────────────────────────────────────────────────────────────────
/** @type {any} */
let port = null
let connectedOnce = false
function connect() {
  port = ext.runtime.connect({ name: 'popup' })
  port.onMessage.addListener((/** @type {any} */ m) => {
    if (m?.type === 'opened' && !connectedOnce) {
      opened = m.unseen ?? zeroUnseen()
      connectedOnce = true
      render()
    }
  })
  // A worker that stopped drops the port: connect again so it keeps knowing the popup is open.
  port.onDisconnect.addListener(() => setTimeout(connect, 200))
}
connect()

ext.storage.onChanged.addListener((/** @type {Record<string, { newValue?: any }>} */ changes, /** @type {string} */ area) => {
  if (area === 'local' && changes.state) {
    state = changes.state.newValue ?? null
    $('#refresh').removeAttribute('aria-busy')
    render()
    if (state?.status === 'ok') startStream()
  }
  if (area === 'local' && changes.unseen) {
    unseen = changes.unseen.newValue ?? zeroUnseen()
    render()
  }
  if (area === 'sync') {
    void loadSettings(ext.storage.sync).then((s) => {
      settings = s
      render()
    })
  }
})


// ── live stream ──────────────────────────────────────────────────────────────────────────────────
/** @type {AbortController | null} */
let stream = null
let streamUp = false
let debounce = 0

function startStream() {
  if (stream || !base()) return
  stream = new AbortController()
  void readStream(base(), stream.signal)
}

/** @param {string} origin @param {AbortSignal} signal */
async function readStream(origin, signal) {
  try {
    const res = await fetch(`${origin}/events/stream`, { credentials: 'include', redirect: 'manual', headers: { accept: 'text/event-stream' }, signal })
    if (!res.ok || !res.body || !(res.headers.get('content-type') ?? '').includes('event-stream')) throw new Error(`HTTP ${res.status}`)
    setLive(true)
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += value
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const name = /^event: (.+)$/m.exec(block)?.[1]
        if (name === 'job' || name === 'runner' || name === 'slot') {
          clearTimeout(debounce)
          debounce = setTimeout(() => port?.postMessage({ type: 'refresh' }), 700)
        }
      }
    }
  } catch {
    // reconnect below
  }
  setLive(false)
  stream = null
  if (!signal.aborted) setTimeout(startStream, 5000)
}

/** @param {boolean} up */
function setLive(up) {
  streamUp = up
  const dot = $('#live')
  const text = up ? 'Live: updates as jobs change' : state?.status === 'ok' ? `Polling every ${settings.pollSeconds} s (live stream reconnecting)` : 'Not connected'
  dot.dataset.status = up ? 'running' : state?.status === 'ok' ? 'degraded' : 'muted'
  dot.dataset.tip = text
  dot.setAttribute('aria-label', text)
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────────

/** @param {ViewJob} j */
const where = (j) => (j.runner ? `${j.runner.host} · ${j.runner.type}` : (j.labels ?? []).filter((l) => l !== 'self-hosted').join(', '))

/** Repos show without their owner unless the view holds more than one owner. */
let owners = 1
/** @param {string} repo */
const repoName = (repo) => (owners > 1 ? repo : shortRepo(repo))

/** @param {ViewJob} j @param {string} trail */
const jobRow = (j, trail) => `
  <div class="pop-job">
    <a class="pop-job-main" href="#" data-open="/jobs/${j.id}">
      <span class="pop-job-name t-truncate">${esc(j.name)}</span>
      <span class="pop-job-sub t-muted t-small t-truncate">${esc(repoName(j.repo))}${where(j) ? ` · ${esc(where(j))}` : ''}</span>
    </a>
    ${trail}
    <a class="t-btn" data-variant="ghost" data-size="xs" data-icon="only" href="#" data-href="${esc(j.htmlUrl)}" aria-label="Open on GitHub" data-tip="Open on GitHub">${icon('bi-github')}</a>
  </div>`

/** @param {ViewJob} j */
function resultBadge(j) {
  const c = j.conclusion
  const tone = c === 'success' ? 'success' : c === 'failure' || c === 'timed_out' ? 'danger' : c === 'cancelled' ? (settings.cancelledAsFailed ? 'danger' : 'neutral') : 'neutral'
  return `<span class="t-badge" data-tone="${tone}" data-size="xs">${esc((c ?? 'unknown').replace('_', ' '))}</span>`
}

/**
 * @param {string} label @param {number} value @param {string} tone @param {string} path @param {string} ico @param {string} [sub]
 */
const tile = (label, value, tone, path, ico, sub = '') => `
  <a class="pop-tile" href="#" data-open="${esc(path)}" data-tone="${tone}" data-zero="${value === 0}">
    <span class="pop-tile-value t-mono">${icon(ico)}${value}</span>
    <span class="pop-tile-label">${esc(label)}${sub ? `<span class="t-muted"> ${esc(sub)}</span>` : ''}</span>
  </a>`

function render() {
  const origin = base()
  $('#host').textContent = origin ? new URL(origin).host : ''
  const body = $('#body')
  const foot = $('#foot')

  if (!origin) {
    foot.hidden = true
    body.innerHTML = `<div class="t-empty pop-empty">
      ${icon('bi-link-45deg').replace('t-icon', 't-icon t-empty-icon')}
      <h3 class="t-empty-title">No hatchery set</h3>
      <p>Enter the URL of your OctoHatchery dashboard to see its jobs here.</p>
      <div class="t-empty-actions"><button class="t-btn" data-variant="primary" type="button" id="go-options">Open options</button></div>
    </div>`
    $('#go-options').addEventListener('click', () => void ext.runtime.openOptionsPage().then(() => window.close()))
    return
  }
  if (!state || state.base !== origin) return

  const parts = []
  const status = state.status
  if (status === 'no_permission') {
    parts.push(`<div class="t-alert" data-tone="warning" role="alert" data-size="sm">
      ${icon('bi-lock').replace('t-icon', 't-icon t-alert-icon')}
      <div class="t-alert-body">The extension may not read <b>${esc(new URL(origin).host)}</b> yet.</div>
      <div class="t-alert-actions"><button class="t-btn" data-size="sm" type="button" id="grant">Allow access</button></div>
    </div>`)
  } else if (status === 'signed_out') {
    parts.push(`<div class="t-alert" data-tone="warning" role="alert" data-size="sm">
      ${icon('bi-box-arrow-in-right').replace('t-icon', 't-icon t-alert-icon')}
      <div class="t-alert-body"><b>Signed out.</b> The sign-in in front of the hatchery asks you to log in again.${state.view ? ' The data below is from the last good poll.' : ''}</div>
      <div class="t-alert-actions"><button class="t-btn" data-size="sm" type="button" data-open="/">Sign in</button></div>
    </div>`)
  } else if (status === 'down') {
    parts.push(`<div class="t-alert" data-tone="danger" role="alert" data-size="sm">
      ${icon('bi-exclamation-triangle').replace('t-icon', 't-icon t-alert-icon')}
      <div class="t-alert-body"><b>No answer from the hatchery</b> (${esc(state.message ?? 'unknown error')}). ${state.view ? 'The data below is from the last good poll.' : ''}</div>
    </div>`)
  }

  /** @type {View | null} */
  const view = state.view
  if (view) {
    owners = new Set([...view.running, ...view.queued.jobs, ...view.recent].map((j) => j.repo.split('/')[0])).size
    const shown = settings.resetOnOpen ? opened : unseen
    const since = settings.resetOnOpen ? 'since last look' : 'since cleared'
    parts.push(`<div class="pop-tiles">
      ${tile('running', view.running.length, 'info', '/jobs?running=1', 'bi-play-fill', settings.counterRunning === 'started' || settings.counterRunning === 'both' ? `${shown.started} started ${since}` : '')}
      ${tile('queued', view.queued.total, 'warning', '/jobs?status=queued', 'bi-hourglass-split')}
      ${tile('succeeded', shown.succeeded, 'success', '/jobs?status=completed', 'bi-check-circle', since)}
      ${tile('failed', shown.failed, 'danger', '/jobs?failed=1', 'bi-x-circle', since)}
    </div>`)
    if (!settings.resetOnOpen && (unseen.succeeded || unseen.failed || unseen.started)) {
      parts.push(`<div class="pop-clear"><button class="t-btn" data-variant="link" data-size="xs" type="button" id="clear">Clear the counters</button></div>`)
    }

    parts.push(`<section class="pop-section"><h2 class="pop-h">Running <span class="t-counter">${view.running.length}</span></h2>`)
    if (view.running.length) {
      parts.push(
        view.running
          .map((j) =>
            jobRow(j, `<span class="pop-job-time t-mono t-small" data-since="${esc(j.startedAt ?? j.queuedAt)}" data-tip="${j.status === 'claimed' ? 'Runner starting' : 'Running'}">${durationText(Date.now() - Date.parse(j.startedAt ?? j.queuedAt))}</span>`),
          )
          .join(''),
      )
    } else {
      parts.push(`<p class="t-muted t-small pop-none">No job is running. ${view.queued.total ? 'Queued jobs start when a slot is free.' : 'New jobs show here when GitHub queues them.'}</p>`)
    }
    parts.push(`</section>`)

    if (view.queued.total) {
      parts.push(`<section class="pop-section"><h2 class="pop-h">Queued <span class="t-counter" data-tone="warning">${view.queued.total}</span></h2>`)
      parts.push(view.queued.jobs.map((j) => jobRow(j, `<span class="pop-job-time t-mono t-small" data-since="${esc(j.queuedAt)}" data-tip="Waiting">${durationText(Date.now() - Date.parse(j.queuedAt))}</span>`)).join(''))
      if (view.queued.total > view.queued.jobs.length) parts.push(`<a class="t-btn pop-more" data-variant="link" data-size="xs" href="#" data-open="/jobs?status=queued">${view.queued.total - view.queued.jobs.length} more queued</a>`)
      parts.push(`</section>`)
    }

    if (view.recent.length) {
      parts.push(`<section class="pop-section"><h2 class="pop-h">Recent</h2>`)
      parts.push(view.recent.map((j) => jobRow(j, `<span class="pop-job-end">${resultBadge(j)}<span class="t-muted t-small">${esc(agoText(j.completedAt, Date.now()))}</span></span>`)).join(''))
      parts.push(`</section>`)
    }

    if (view.hosts.length) {
      parts.push(`<section class="pop-section"><h2 class="pop-h">Hosts</h2><div class="pop-hosts">`)
      for (const h of view.hosts) {
        const dot = h.status !== 'online' ? 'stopped' : !h.dockerOk ? 'degraded' : 'running'
        const tip = h.status !== 'online' ? 'offline' : !h.dockerOk ? 'Docker unreachable' : 'online'
        parts.push(`<a class="pop-host-chip" href="#" data-open="/hosts" data-full="${h.count > 0 && h.used >= h.count}">
          <span class="t-dot" data-status="${dot}" data-tip="${tip}" aria-label="${tip}"></span>
          <span class="t-truncate">${esc(h.name)}</span>
          <span class="t-mono t-small t-muted" data-tip="Busy slots of all slots">${h.used}/${h.count}</span>
        </a>`)
      }
      parts.push(`</div></section>`)
    }
  }
  body.innerHTML = parts.join('')
  foot.hidden = false
  $('#updated').textContent = view ? `${view.version ? `v${view.version} · ` : ''}${agoText(new Date(state.at).toISOString(), Date.now())}` : ''
  $('#updated').dataset.at = String(state.at)
  setLive(streamUp)

  $('#grant', body)?.addEventListener('click', async () => {
    const ok = await ext.permissions.request({ origins: [originPattern(origin)] }).catch(() => false)
    if (ok) port?.postMessage({ type: 'refresh' })
  })
  $('#clear', body)?.addEventListener('click', () => void ext.runtime.sendMessage({ type: 'reset' }))
}

// Running and waiting times count up between polls.
setInterval(() => {
  const now = Date.now()
  for (const el of document.querySelectorAll('[data-since]')) el.textContent = durationText(now - Date.parse(/** @type {HTMLElement} */ (el).dataset.since ?? ''))
  const at = Number($('#updated')?.dataset.at)
  if (at && state?.view) $('#updated').textContent = `${state.view.version ? `v${state.view.version} · ` : ''}${agoText(new Date(at).toISOString(), now)}`
}, 1000)

// ── start ──────────────────────────────────────────────────────────────────────────────────────────
const stored = await ext.storage.local.get(['state', 'unseen'])
state = stored.state ?? null
unseen = stored.unseen ?? zeroUnseen()
render()
if (state?.status === 'ok') startStream()
if (base()) void followTheme(base(), settings)

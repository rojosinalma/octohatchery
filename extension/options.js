// Options page: the hatchery URL (with its host permission and a connection test), the alerts, the toolbar
// counters and the poll interval. Every control saves on change through Tailor.settingsAutoSave.

import { getJson, probe } from './lib/api.js'
import { ext } from './lib/browser.js'
import { checkSetting, loadSettings, normalizeUrl, originPattern } from './lib/settings.js'
import { $, esc, followTheme, tailorReady, toast } from './ui.js'

const sync = ext.storage.sync
let settings = await loadSettings(sync)
const T = /** @type {any} */ (await tailorReady())
const urlInput = /** @type {HTMLInputElement} */ ($('#url'))

$('#ext-version').textContent = ext.runtime.getManifest().version

// ── fill the controls, then let tailor draw them ─────────────────────────────────────────────────
for (const el of /** @type {NodeListOf<HTMLInputElement | HTMLSelectElement>} */ (document.querySelectorAll('input[data-setting], select[data-setting]'))) {
  const v = /** @type {any} */ (settings)[el.dataset.setting ?? '']
  if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!v
  else el.value = String(v)
}
$('.t-duration[data-setting="pollSeconds"]').dataset.value = String(settings.pollSeconds)
urlInput.value = settings.url
showPickers()
showAlertRows()
T.upgrade(document)
T.settingsAutoSave($('#settings'), save)

/** @param {string} key @param {unknown} value */
async function save(key, value) {
  const checked = checkSetting(key, value)
  if (!checked.ok) return { ok: false, message: checked.message }
  await sync.set({ [key]: checked.value })
  settings = await loadSettings(sync)
  if (key === 'alertsEnabled') {
    showAlertRows()
    return { ok: true, message: settings.alertsEnabled ? 'Notifications on' : 'Notifications off' }
  }
  if (key === 'themeFromHatchery') {
    showPickers()
    if (settings.themeFromHatchery && settings.url) await followTheme(settings.url, settings)
    return { ok: true, message: settings.themeFromHatchery ? "Uses the hatchery's look" : 'Pick a skin, palette and mode below' }
  }
  return { ok: true, message: 'Saved' }
}

// ── alerts: the kind switches, repo filter and test button only matter while notifications are on.
// "Count cancelled jobs as failed" also drives the counters, so it stays usable. ──
function showAlertRows() {
  const box = $('#alert-rows')
  box.dataset.off = String(!settings.alertsEnabled)
  for (const el of box.querySelectorAll('input:not(#s-cancelledAsFailed), button')) /** @type {HTMLInputElement} */ (el).disabled = !settings.alertsEnabled
}

// ── appearance: the skin and palette pickers apply only when the extension does not follow the hatchery ──
function showPickers() {
  $('#theme-pickers-row').hidden = settings.themeFromHatchery
}
let themeToast = 0
document.documentElement.addEventListener('t:theme', () => {
  if (settings.themeFromHatchery) return
  // One toast for a burst of changes (a palette change can also change the mode).
  clearTimeout(themeToast)
  themeToast = setTimeout(() => {
    const t = T.theme.get()
    void toast('success', `Look saved: ${T.theme.labels?.skins?.[t.skin] ?? t.skin}, ${T.theme.labels?.palettes?.[t.palette] ?? t.palette}, ${t.mode}`)
  }, 150)
})

// ── hatchery URL ─────────────────────────────────────────────────────────────────────────────────
const feedback = $('#url-feedback')
/** @param {'success' | 'danger' | 'info'} tone @param {string} html */
function say(tone, html) {
  feedback.dataset.tone = tone
  feedback.innerHTML = html
}

function showActions() {
  $('#url-actions').hidden = !settings.url
}

$('#url-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const input = urlInput
  const url = normalizeUrl(input.value)
  if (!url) {
    input.setAttribute('aria-invalid', 'true')
    say('danger', 'Enter an http or https URL, for example https://hatchery.example.com')
    return
  }
  input.removeAttribute('aria-invalid')
  input.value = url
  // The permission prompt needs the click: ask before anything else is awaited.
  const granted = await ext.permissions.request({ origins: [originPattern(url)] }).catch((/** @type {Error} */ err) => {
    say('danger', esc(err.message))
    return false
  })
  if (!granted) {
    say('danger', `Access to ${esc(new URL(url).host)} was not allowed, so nothing changed.`)
    return
  }
  const old = settings.url
  const btn = $('#connect')
  btn.setAttribute('aria-busy', 'true')
  btn.setAttribute('disabled', '')
  const result = await probe(url)
  btn.removeAttribute('aria-busy')
  btn.removeAttribute('disabled')
  if (old !== url) {
    await sync.set({ url, alertRepos: [] })
    settings = await loadSettings(sync)
    if (old) await ext.permissions.remove({ origins: [originPattern(old)] }).catch(() => {})
  }
  showActions()
  report(result, url)
  void toast(result.ok ? 'success' : 'warning', result.ok ? `Connected to ${new URL(url).host}` : `Saved ${new URL(url).host}, but the test failed`)
  if (result.ok) {
    void loadRepos()
    void followTheme(url, settings)
  }
})

/** @param {Awaited<ReturnType<typeof probe>>} result @param {string} url */
function report(result, url) {
  if (result.ok) {
    say('success', `Connected: OctoHatchery ${esc(result.version)}${result.host ? ` on node ${esc(result.host)}` : ''}.`)
    $('#hatchery-version').textContent = `${result.version} at ${url}`
  } else {
    say('danger', esc(result.message))
    $('#hatchery-version').textContent = 'not connected'
  }
}

$('#test').addEventListener('click', async () => {
  const btn = $('#test')
  btn.setAttribute('aria-busy', 'true')
  btn.setAttribute('disabled', '')
  const has = await ext.permissions.contains({ origins: [originPattern(settings.url)] })
  const result = has ? await probe(settings.url) : { ok: /** @type {const} */ (false), kind: /** @type {const} */ ('error'), message: 'Access to this site is not allowed. Click Connect to allow it.' }
  btn.removeAttribute('aria-busy')
  btn.removeAttribute('disabled')
  report(result, settings.url)
  void toast(result.ok ? 'success' : 'danger', result.ok ? 'The connection works' : 'The connection test failed')
  if (result.ok) void ext.runtime.sendMessage({ type: 'poll' }).catch(() => {})
})

$('#open').addEventListener('click', () => void ext.tabs.create({ url: `${settings.url}/` }))

$('#disconnect').addEventListener('click', async () => {
  const ok = await T.confirm('Disconnect from this hatchery?', '<p>The extension stops polling and clears its counters. You can connect again at any time.</p>', { label: 'Disconnect' }).catch(() => false)
  if (!ok) return
  const old = settings.url
  await sync.set({ url: '', alertRepos: [] })
  settings = await loadSettings(sync)
  if (old) await ext.permissions.remove({ origins: [originPattern(old)] }).catch(() => {})
  urlInput.value = ''
  say('info', 'Disconnected.')
  $('#hatchery-version').textContent = 'not connected'
  showActions()
  renderRepos(null)
  void toast('success', `Disconnected from ${new URL(old).host}`)
})

// ── repo filter: the hatchery's adopted repos as checkboxes ──────────────────────────────────────
/** @param {string[] | null} repos */
function renderRepos(repos) {
  const box = $('#repos')
  if (!repos) {
    box.innerHTML = '<span class="t-muted t-small">Connect to a hatchery to list its repos.</span>'
    return
  }
  const picked = new Set(settings.alertRepos)
  // A repo picked earlier but no longer adopted stays listed, so it can be unticked.
  const all = [...new Set([...repos, ...picked])].sort((a, b) => a.localeCompare(b))
  if (!all.length) {
    box.innerHTML = '<span class="t-muted t-small">The hatchery has no adopted repos yet.</span>'
    return
  }
  box.innerHTML = all
    .map(
      (r) => `<label class="t-check"><input class="t-check-input" type="checkbox" value="${esc(r)}" ${picked.has(r) ? 'checked' : ''}><span class="t-check-label">${esc(r)}${repos.includes(r) ? '' : '<span class="t-check-desc">no longer adopted</span>'}</span></label>`,
    )
    .join('')
  showAlertRows()
}

async function loadRepos() {
  if (!settings.url || !(await ext.permissions.contains({ origins: [originPattern(settings.url)] }))) return renderRepos(null)
  const r = await getJson(settings.url, '/api/repos')
  renderRepos(r.kind === 'ok' ? (r.data.repos ?? []).filter((/** @type {any} */ x) => x.adopted !== false).map((/** @type {any} */ x) => String(x.fullName)) : [])
}

$('#repos').addEventListener('change', async () => {
  const value = [...document.querySelectorAll('#repos input:checked')].map((el) => /** @type {HTMLInputElement} */ (el).value)
  const row = /** @type {HTMLElement} */ ($('#repos').closest('.t-setting'))
  row.dataset.state = 'saving'
  const res = await save('alertRepos', value)
  row.dataset.state = res.ok ? 'saved' : 'failed'
  void toast(res.ok ? 'success' : 'danger', res.ok ? (value.length ? `Alerts for ${value.length} repo${value.length === 1 ? '' : 's'}` : 'Alerts for every repo') : res.message)
})

// ── test alert ───────────────────────────────────────────────────────────────────────────────────
$('#test-alert').addEventListener('click', async () => {
  await ext.notifications.create('oh:test', {
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title: 'Failed: build (test alert)',
    message: 'acme/app · node-a · generic · took 3m 12s',
  })
  void toast('info', 'Test alert sent')
})

// ── start ────────────────────────────────────────────────────────────────────────────────────────
showActions()
if (settings.url) {
  const has = await ext.permissions.contains({ origins: [originPattern(settings.url)] })
  if (has) {
    void probe(settings.url).then((r) => report(r, settings.url))
    void loadRepos()
    void followTheme(settings.url, settings)
  } else {
    say('danger', 'Access to this site is not allowed. Click Connect to allow it.')
  }
} else {
  say('info', 'Enter the URL and click Connect.')
}

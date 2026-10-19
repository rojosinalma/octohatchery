/* OctoHatchery dashboard — progressive enhancement. Vanilla, no build step.
   Every action calls the JSON API with fetch, reports the {ok, message} outcome as a toast and
   never reloads the page. An EventSource on /events/stream refreshes live blocks in place. */
(function () {
  'use strict'

  var T = window.Tailor
  var $ = function (sel, root) { return (root || document).querySelector(sel) }
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)) }
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }

  /* ── API ─────────────────────────────────────────────────────────────────── */
  function api(method, path, body) {
    var init = { method: method, headers: { accept: 'application/json' } }
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body) }
    return fetch(path, init).then(function (res) {
      return res.text().then(function (text) {
        var data
        try { data = text ? JSON.parse(text) : {} } catch (e) { data = { ok: false, message: 'Unexpected answer (' + res.status + ')' } }
        if (typeof data.ok !== 'boolean') data.ok = res.ok
        if (!data.message) data.message = res.ok ? 'Done' : 'Request failed (' + res.status + ')'
        return data
      })
    }, function (err) { return { ok: false, message: 'Network error: ' + err.message } })
  }
  function toast(res) { T.toast(res.ok ? 'success' : 'danger', res.message); return res }
  function busy(btn, on) {
    if (!btn) return
    if (on) { btn.setAttribute('aria-busy', 'true'); btn.disabled = true } else { btn.removeAttribute('aria-busy'); btn.disabled = false }
  }

  /* ── Re-render in place ──────────────────────────────────────────────────── */
  // Fetch the current page again and swap one element by id (or the whole main).
  function refetch(url) { return fetch(url, { headers: { accept: 'text/html' } }).then(function (r) { return r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)) }) }
  function swapMain() {
    return refetch(location.pathname + location.search).then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html')
      var fresh = $('main.t-shell-main', doc), main = $('main.t-shell-main')
      if (!fresh || !main) return
      main.innerHTML = fresh.innerHTML
      T.upgrade(main)
      wireSlots(main)
    }).catch(function (err) { T.toast('warning', 'Could not refresh: ' + err.message) })
  }
  // Live blocks carry data-live="<event names>"; a matching SSE event re-fetches `?partial=1` and replaces the block.
  var pending = null
  function refreshLive() {
    pending = null
    var block = $('[data-live]')
    if (!block) return
    var q = new URLSearchParams(location.search); q.set('partial', '1')
    refetch(location.pathname + '?' + q.toString()).then(function (html) {
      var tpl = document.createElement('template'); tpl.innerHTML = html.trim()
      var fresh = tpl.content.firstElementChild
      var current = $('[data-live]')
      if (!fresh || !current) return
      current.replaceWith(fresh)
      T.upgrade(fresh)
    }).catch(function () { /* next event retries */ })
  }
  function scheduleLive(name) {
    var block = $('[data-live]')
    if (!block || block.dataset.live.split(/\s+/).indexOf(name) < 0) return
    if (pending) clearTimeout(pending)
    pending = setTimeout(refreshLive, 300)
  }

  /* ── SSE ─────────────────────────────────────────────────────────────────── */
  function liveDot(status, tip) { var d = $('#live-dot'); if (d) { d.dataset.status = status; d.dataset.tip = 'Live updates: ' + tip } }
  function connect() {
    if (!window.EventSource) return
    var es = new EventSource('/events/stream')
    es.onopen = function () { liveDot('running', 'connected') }
    es.onerror = function () { liveDot('degraded', 'reconnecting') }
    ;['runner', 'job', 'slot', 'event'].forEach(function (name) { es.addEventListener(name, function () { scheduleLive(name) }) })
  }

  /* ── Actions (delegated) ─────────────────────────────────────────────────── */
  var actions = {
    kill: function (btn) {
      var job = btn.dataset.job ? '<p>It is working on <b>' + esc(btn.dataset.job) + '</b>; that job fails and GitHub re-queues it only if the workflow says so.</p>' : '<p>It is idle.</p>'
      return T.confirm('Kill runner ' + btn.dataset.name + '?', job + '<p>The container is stopped and the runner is deregistered.</p>', { label: 'Kill', danger: true })
        .then(function (ok) { if (!ok) return; busy(btn, true); return api('DELETE', '/api/runners/' + encodeURIComponent(btn.dataset.id)).then(toast).then(function () { busy(btn, false); scheduleLive('runner') }) })
    },
    unadopt: function (btn) {
      var repo = btn.dataset.repo
      return T.confirm('Unadopt ' + repo + '?', '<p>The webhook is removed and new jobs from this repo are ignored. Running jobs finish.</p>', { label: 'Unadopt', danger: true })
        .then(function (ok) { if (!ok) return; busy(btn, true); return api('POST', '/api/repos/unadopt', { fullName: repo }).then(toast).then(function (res) { if (res.ok) swapMain(); else busy(btn, false) }) })
    },
    'runs-on': function (btn) {
      var dlg = $('#runs-on-dlg'); if (!dlg) return
      dlg.dataset.repo = btn.dataset.repo
      $('#runs-on-repo', dlg).textContent = btn.dataset.repo
      dlg.showModal()
    },
    'runs-on-apply': function (btn) {
      var dlg = btn.closest('dialog'), repo = dlg && dlg.dataset.repo, mode = btn.dataset.mode, type = btn.dataset.type
      if (!repo) return
      var body = mode === 'commit'
        ? '<p>Every workflow in <b>' + esc(repo) + '</b> that uses GitHub-hosted runners is changed to <code>runs-on: [self-hosted, ' + esc(type) + ']</code> and committed to the default branch.</p>'
        : '<p>A branch and a pull request are opened on <b>' + esc(repo) + '</b> switching its workflows to <code>runs-on: [self-hosted, ' + esc(type) + ']</code>. Nothing changes until you merge.</p>'
      return T.confirm(mode === 'commit' ? 'Commit to the default branch?' : 'Open a pull request?', body, { label: mode === 'commit' ? 'Commit' : 'Open PR', danger: mode === 'commit' })
        .then(function (ok) {
          if (!ok) return
          busy(btn, true)
          return api('POST', '/api/repos/runs-on', { fullName: repo, mode: mode, type: type }).then(function (res) {
            busy(btn, false)
            if (res.ok && res.prUrl) res.message = (res.message || 'Pull request opened') + ' — ' + res.prUrl
            if (res.ok && res.commitSha) res.message = (res.message || 'Committed') + ' — ' + String(res.commitSha).slice(0, 7)
            toast(res)
            if (res.ok) dlg.close('')
          })
        })
    },
    'type-new': function () { fillTypeForm(null); $('#type-dlg').showModal() },
    'type-edit': function (btn) { fillTypeForm(JSON.parse(btn.dataset.type)); $('#type-dlg').showModal() },
    'type-delete': function (btn) {
      var name = btn.dataset.name
      return T.confirm('Delete runner type ' + name + '?', '<p>Its slots go with it. Running runners of this type finish their job. Jobs asking for the <code>' + esc(name) + '</code> label stay queued on GitHub.</p>', { label: 'Delete', danger: true })
        .then(function (ok) { if (!ok) return; busy(btn, true); return api('DELETE', '/api/runner-types/' + encodeURIComponent(name)).then(toast).then(function (res) { if (res.ok) swapMain(); else busy(btn, false) }) })
    },
    spawn: function (btn) {
      busy(btn, true)
      return api('POST', '/api/runners/spawn', { type: btn.dataset.type, host: btn.dataset.host }).then(toast).then(function () { busy(btn, false) })
    },
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]')
    if (!btn || btn.tagName === 'FORM') return
    var fn = actions[btn.dataset.action]
    if (!fn) return
    e.preventDefault()
    fn(btn)
  })

  /* ── Forms ───────────────────────────────────────────────────────────────── */
  var lines = function (s) { return s.split(/\r?\n/).map(function (l) { return l.trim() }).filter(Boolean) }
  var list = function (s) { return s.split(',').map(function (l) { return l.trim() }).filter(Boolean) }

  function fillTypeForm(type) {
    var f = $('#type-form'); if (!f) return
    f.reset()
    $('#type-dlg-title').textContent = type ? 'Edit runner type' : 'New runner type'
    f.elements.name.readOnly = Boolean(type)
    if (!type) return
    f.elements.name.value = type.name
    f.elements.description.value = type.description || ''
    f.elements.image.value = type.image
    f.elements.labels.value = (type.labels || []).join(', ')
    f.elements.cpus.value = type.cpus
    f.elements.memoryMb.value = type.memoryMb
    f.elements.mounts.value = (type.mounts || []).join('\n')
    f.elements.env.value = Object.keys(type.env || {}).map(function (k) { return k + '=' + type.env[k] }).join('\n')
    f.elements.secretEnv.value = (type.secretEnv || []).join(', ')
    $$('input, select, textarea', f).forEach(function (el) { T.sync(el) })
  }

  var forms = {
    adopt: function (f, submit) {
      var name = f.elements.fullName.value.trim()
      busy(submit, true)
      return api('POST', '/api/repos/adopt', { fullName: name }).then(toast).then(function (res) { busy(submit, false); if (res.ok) { f.reset(); swapMain() } })
    },
    'type-save': function (f, submit) {
      var env = {}
      lines(f.elements.env.value).forEach(function (l) { var i = l.indexOf('='); if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1) })
      var name = f.elements.name.value.trim()
      var payload = {
        description: f.elements.description.value.trim() || null,
        labels: list(f.elements.labels.value),
        image: f.elements.image.value.trim(),
        cpus: Number(f.elements.cpus.value),
        memoryMb: Number(f.elements.memoryMb.value),
        mounts: lines(f.elements.mounts.value),
        env: env,
        secretEnv: list(f.elements.secretEnv.value),
      }
      busy(submit, true)
      return api('PUT', '/api/runner-types/' + encodeURIComponent(name), payload).then(toast).then(function (res) {
        busy(submit, false)
        if (res.ok) { f.closest('dialog').close(''); swapMain() }
      })
    },
  }

  document.addEventListener('submit', function (e) {
    var f = e.target.closest('form[data-action]')
    if (!f) return
    e.preventDefault()
    if (T.validate && !T.validate(f)) return
    var fn = forms[f.dataset.action]
    if (fn) fn(f, f.querySelector('[type=submit]'))
  })

  /* ── Slots matrix: save per cell on change, revert on failure ────────────── */
  function wireSlots(root) {
    $$('input[data-slot-type]', root).forEach(function (input) {
      if (input.dataset.wired !== undefined) return
      input.dataset.wired = ''
      input.addEventListener('change', function () {
        var count = Math.max(0, Math.round(Number(input.value) || 0))
        var cell = input.closest('td')
        if (cell) cell.setAttribute('aria-busy', 'true')
        api('PUT', '/api/slots', { host: input.dataset.slotHost, type: input.dataset.slotType, count: count }).then(toast).then(function (res) {
          if (cell) cell.removeAttribute('aria-busy')
          if (res.ok) { input.dataset.last = String(count); input.value = String(count) } else { input.value = input.dataset.last }
          T.sync(input)
        })
      })
    })
  }

  /* ── Jobs filter: repo select navigates ──────────────────────────────────── */
  document.addEventListener('change', function (e) {
    var sel = e.target.closest('[data-nav]')
    if (!sel) return
    var q = new URLSearchParams(location.search)
    if (sel.value) q.set(sel.dataset.nav, sel.value); else q.delete(sel.dataset.nav)
    var s = q.toString()
    location.assign(location.pathname + (s ? '?' + s : ''))
  })

  /* ── Settings: auto-save rows, theme as a setting ───────────────────────── */
  function saveSetting(key, value) { return api('PUT', '/api/settings/' + encodeURIComponent(key), { value: String(value) }) }
  function wireSettings() {
    var root = $('#settings')
    if (root) {
      T.settingsAutoSave(root, function (key, value) {
        var group = root.querySelector('[data-setting="' + key + '"]')
        var scale = group && group.dataset.scale ? Number(group.dataset.scale) : 1
        return saveSetting(key, scale > 1 ? Math.round(Number(value) / scale) : value)
      })
    }
    // Seeded from the pre-paint snippet so the initial paint does not write the stored values back.
    var h = document.documentElement.dataset
    var last = { ui_skin: h.skin, ui_palette: h.palette, ui_mode: h.modeChoice || h.mode }
    document.documentElement.addEventListener('t:theme', function (e) {
      var th = e.detail || {}
      var next = { ui_skin: th.skin, ui_palette: th.palette, ui_mode: th.choice || th.mode }
      Object.keys(next).forEach(function (k) {
        if (!next[k] || last[k] === next[k]) return
        last[k] = next[k]
        saveSetting(k, next[k]).then(function (res) { if (!res.ok) T.toast('warning', 'Theme not saved: ' + res.message) })
      })
    })
  }

  /* ── Boot ────────────────────────────────────────────────────────────────── */
  function boot() {
    if (!T) return
    wireSlots(document)
    wireSettings()
    connect()
    var side = $('.t-shell-side .t-sidebar')
    if (side && T.scrollspy) T.scrollspy(side)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot()
})()

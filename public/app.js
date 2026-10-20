/* OctoHatchery dashboard — progressive enhancement. Vanilla, no build step.
   Every action calls the JSON API with fetch, reports the {ok, message} outcome as a toast and
   never reloads the page. An EventSource on /events/stream refreshes live blocks in place. */
(function () {
  'use strict'

  var T = window.Tailor
  var $ = function (sel, root) { return (root || document).querySelector(sel) }
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)) }
  var plainText = function (s) { return String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') }
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
      wireChips(main)
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
    webhook: function (btn) {
      busy(btn, true)
      return api('POST', '/api/repos/webhook', { fullName: btn.dataset.repo }).then(toast).then(function (res) { if (res.ok) swapMain(); else busy(btn, false) })
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
      // A result line from an earlier run belongs to that repo: restore the buttons.
      $$('.runs-on-result', dlg).forEach(function (r) { var tb = r.previousElementSibling; if (tb) tb.hidden = false; r.remove() })
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
            // Failure: GitHub's exact message, dialog stays open. Success: the buttons give way to the result and its link.
            var toolbar = btn.closest('.t-toolbar')
            $$('.runs-on-error', toolbar.parentNode).forEach(function (n) { n.remove() })
            if (!res.ok) {
              // The modal dims everything outside it, so the exact message also lands inside the dialog, URLs clickable.
              T.toast('danger', res.message)
              var alert = document.createElement('div')
              alert.className = 't-alert runs-on-error'
              alert.dataset.tone = 'danger'
              alert.setAttribute('role', 'alert')
              alert.innerHTML = '<svg class="t-icon" aria-hidden="true"><use href="/tailor/icons.svg#bi-exclamation-triangle"/></svg><div class="t-alert-body">' + esc(res.message).replace(/https?:\/\/[^\s.,;)]+(?:\.[^\s.,;)]+)*/g, function (u) { return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>' }) + '</div>'
              toolbar.insertAdjacentElement('afterend', alert)
              return
            }
            var url = res.prUrl || res.htmlUrl
            var label = res.prUrl ? 'Pull request opened' : 'Committed ' + String(res.commitSha || '').slice(0, 7)
            var line = document.createElement('div')
            line.className = 't-cluster runs-on-result'
            line.dataset.gap = '2'
            line.dataset.align = 'center'
            line.innerHTML = '<span class="t-badge" data-tone="success">' + esc(label) + '</span>'
              + (res.files && res.files.length ? '<span class="t-small t-muted">' + esc(res.files.length + ' workflow' + (res.files.length === 1 ? '' : 's')) + '</span>' : '')
              + (url ? '<a class="t-btn" data-size="sm" data-variant="primary" href="' + esc(url) + '" target="_blank" rel="noopener"><svg class="t-icon" aria-hidden="true"><use href="/tailor/icons.svg#bi-box-arrow-up-right"/></svg> ' + esc(res.prUrl ? 'Open the pull request' : 'Open the commit') + '</a>' : '')
            toolbar.hidden = true
            toolbar.insertAdjacentElement('afterend', line)
            T.toast('success', res.message)
          })
        })
    },
    'github-recheck': function (btn) {
      busy(btn, true)
      return api('POST', '/api/github/recheck').then(function (res) {
        busy(btn, false)
        T.toast(res.ok && res.status && res.status.ok ? 'success' : res.ok ? 'warning' : 'danger', res.message)
        if (res.ok) swapMain().then(function () { var s = $('#github'); if (s) s.scrollIntoView() })
      })
    },
    'adopt-open': function () {
      var dlg = $('#adopt-dlg'); if (!dlg) return
      dlg.showModal()
      loadAdoptList(dlg)
    },
    'adopt-pick': function (btn) {
      var dlg = btn.closest('dialog'), name = btn.dataset.repo
      $$('[data-action="adopt-pick"]', dlg).forEach(function (b) { b.disabled = true })
      busy(btn, true)
      return api('POST', '/api/repos/adopt', { fullName: name }).then(function (res) {
        toast(res)
        if (res.ok) { dlg.close(''); swapMain(); return }
        busy(btn, false)
        $$('[data-action="adopt-pick"]', dlg).forEach(function (b) { if (b.dataset.adopted === undefined) b.disabled = false })
      })
    },
    'type-new': function () { fillTypeForm(null); $('#type-dlg').showModal() },
    'type-edit': function (btn) { fillTypeForm(JSON.parse(btn.dataset.type)); $('#type-dlg').showModal() },
    'type-delete': function (btn) {
      var name = btn.dataset.name
      return T.confirm('Delete template ' + name + '?', '<p>Its slots go with it. Running runners of this template finish their job. Jobs asking for the <code>' + esc(name) + '</code> label stay queued on GitHub.</p>', { label: 'Delete', danger: true })
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

  function setRadio(form, name, value) {
    $$('input[type=radio][name="' + name + '"]', form).forEach(function (r) { r.checked = r.value === value })
  }

  function fillTypeForm(type) {
    var f = $('#type-form'); if (!f) return
    f.reset()
    $('#type-dlg-title').textContent = type ? 'Edit template' : 'New template'
    f.elements.name.readOnly = Boolean(type)
    setChips(f, type ? type.labels || [] : [])
    setRadio(f, 'docker', type && type.docker ? type.docker : 'none')
    if (!type) { syncTypeBadge(f); return }
    f.elements.name.value = type.name
    syncTypeBadge(f)
    f.elements.description.value = type.description || ''
    f.elements.image.value = type.image
    f.elements.cpus.value = type.cpus
    f.elements.memoryMb.value = type.memoryMb
    f.elements.mounts.value = (type.mounts || []).join('\n')
    f.elements.env.value = Object.keys(type.env || {}).map(function (k) { return k + '=' + type.env[k] }).join('\n')
    f.elements.secretEnv.value = (type.secretEnv || []).join(', ')
    $$('input, select, textarea', f).forEach(function (el) { T.sync(el) })
  }

  /* ── Adopt dialog: the repos GitHub lets us see, filtered as you type, one click adopts ── */
  function adoptAlert(tone, html) {
    return '<div class="t-alert" data-tone="' + tone + '" role="alert"><svg class="t-icon" aria-hidden="true"><use href="/tailor/icons.svg#bi-' + (tone === 'danger' ? 'exclamation-triangle' : 'info-circle') + '"/></svg><div class="t-alert-body">' + html + '</div></div>'
  }
  function loadAdoptList(dlg) {
    var list = $('#adopt-list', dlg), state = $('#adopt-state', dlg), search = $('#adopt-search', dlg), count = $('#adopt-count', dlg)
    list.innerHTML = ''
    state.innerHTML = '<div class="t-cluster" data-gap="2" data-align="center"><span class="t-spinner" aria-hidden="true"></span><span class="t-muted">Asking GitHub for the repositories it can see…</span></div>'
    search.value = ''
    search.disabled = true
    count.textContent = ''
    api('GET', '/api/github/repos').then(function (res) {
      if (!res.ok) {
        var fix = res.code === 'invalid'
          ? '<p>GitHub refused the list: a permission is missing or the credentials are wrong.</p>'
          : /GITHUB_AUTH=none/.test(res.message) ? '<p>No GitHub access is configured on this node.</p>' : ''
        state.innerHTML = adoptAlert('danger', '<b>' + esc(res.message) + '</b>' + fix + '<p><a class="t-btn" data-size="sm" href="/settings#github">' + (/GITHUB_AUTH=none/.test(res.message) ? 'Configure GitHub access' : 'Check GitHub permissions') + '</a></p>')
        return
      }
      var repos = res.repos || []
      if (!repos.length) {
        state.innerHTML = res.source === 'app'
          ? adoptAlert('info', '<b>The App is installed on no repositories.</b><p>Add repositories to the installation on GitHub, then open this dialog again.</p>' + (res.installUrl ? '<p><a class="t-btn" data-size="sm" href="' + esc(res.installUrl) + '" target="_blank" rel="noopener">Open the installation</a></p>' : ''))
          : adoptAlert('info', '<b>The token can see no repositories.</b><p>Grant it access to the repositories you want to adopt, then open this dialog again.</p><p><a class="t-btn" data-size="sm" href="/settings#github">Check GitHub permissions</a></p>')
        return
      }
      state.innerHTML = ''
      search.disabled = false
      list.innerHTML = repos.map(function (r) {
        return '<button class="t-list-item" role="option" aria-selected="false" data-action="adopt-pick" data-repo="' + esc(r.fullName) + '" data-name="' + esc(r.fullName.toLowerCase()) + '"' + (r.adopted ? ' disabled data-adopted' : '') + '>'
          + '<svg class="t-icon t-list-lead" aria-hidden="true"><use href="/tailor/icons.svg#bi-github"/></svg>'
          + '<span class="t-list-body"><span class="t-list-name">' + esc(r.fullName) + '</span><span class="t-list-desc">default branch ' + esc(r.defaultBranch) + '</span></span>'
          + '<span class="t-list-trail t-cluster" data-gap="1">' + (r.adopted ? '<span class="t-badge" data-tone="success">adopted</span>' : '') + '<span class="t-badge" data-tone="' + (r.isPrivate ? 'neutral' : 'info') + '">' + (r.isPrivate ? 'private' : 'public') + '</span></span>'
          + '</button>'
      }).join('')
      filterAdoptList(dlg)
      search.focus()
    })
  }
  function filterAdoptList(dlg) {
    var q = $('#adopt-search', dlg).value.trim().toLowerCase(), shown = 0, total = 0
    $$('#adopt-list [data-action="adopt-pick"]', dlg).forEach(function (b) {
      total++
      var hit = !q || b.dataset.name.indexOf(q) >= 0
      b.hidden = !hit
      if (hit) shown++
    })
    var count = $('#adopt-count', dlg)
    count.textContent = q ? shown + ' of ' + total : total + ' repositor' + (total === 1 ? 'y' : 'ies')
    $('#adopt-none', dlg).hidden = shown > 0
  }
  document.addEventListener('input', function (e) {
    if (e.target.id === 'adopt-search') filterAdoptList(e.target.closest('dialog'))
  })

  var forms = {
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
        docker: f.elements.docker.value || 'none',
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

  /* ── Chip input: labels as removable badges over a hidden comma-separated field ── */
  var LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/
  function chipsOf(box) { return $$('.t-badge:not([data-fixed])', box).map(function (b) { return b.dataset.value }) }
  function writeChips(box) {
    var hidden = document.getElementById(box.dataset.chipsFor)
    if (!hidden) return
    hidden.value = chipsOf(box).join(',')
    hidden.dispatchEvent(new Event('input', { bubbles: true }))
  }
  function addChip(box, raw) {
    var value = String(raw).trim().toLowerCase()
    if (!value) return false
    var fixed = $$('.t-badge[data-fixed]', box).map(function (b) { return b.textContent.trim() })
    if (!LABEL_RE.test(value)) { T.toast('warning', 'Label "' + value + '" must be lowercase letters, digits, "-" or "_"'); return false }
    if (value === 'self-hosted' || fixed.indexOf(value) >= 0) { T.toast('info', '"' + value + '" is always added'); return false }
    if (chipsOf(box).indexOf(value) >= 0) return false
    var chip = document.createElement('span')
    chip.className = 't-badge'
    chip.dataset.tone = 'neutral'
    chip.dataset.value = value
    chip.innerHTML = esc(value) + '<button type="button" class="chip-remove" aria-label="Remove ' + esc(value) + '">×</button>'
    box.insertBefore(chip, $('.chip-entry', box))
    writeChips(box)
    return true
  }
  function setChips(form, values) {
    var box = $('.chip-input', form)
    if (!box) return
    $$('.t-badge:not([data-fixed])', box).forEach(function (b) { b.remove() })
    values.forEach(function (v) { addChip(box, v) })
    writeChips(box)
  }
  // The type badge mirrors the Name field; "type" until a name is typed.
  function syncTypeBadge(form) {
    var badge = $('#tf-labels-type', form)
    if (badge) badge.textContent = form.elements.name.value.trim() || 'type'
  }
  function wireChips(root) {
    $$('.chip-input', root).forEach(function (box) {
      if (box.dataset.wired !== undefined) return
      box.dataset.wired = ''
      var entry = $('.chip-entry', box)
      var commit = function () { if (addChip(box, entry.value) || !entry.value.trim()) entry.value = '' }
      entry.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { e.preventDefault(); commit(); return }
        if (e.key === 'Backspace' && !entry.value) {
          var last = $$('.t-badge:not([data-fixed])', box).pop()
          if (last) { last.remove(); writeChips(box) }
        }
      })
      entry.addEventListener('blur', commit)
      box.addEventListener('click', function (e) {
        var rm = e.target.closest('.chip-remove')
        if (rm) { rm.closest('.t-badge').remove(); writeChips(box); entry.focus(); return }
        if (e.target === box) entry.focus()
      })
    })
    $$('#type-form', root).forEach(function (f) {
      if (f.dataset.badgeWired !== undefined) return
      f.dataset.badgeWired = ''
      f.elements.name.addEventListener('input', function () { syncTypeBadge(f) })
    })
  }

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

  /* ── Jobs filter: selects navigate on change, the search box on Enter (or after a pause) ── */
  function navWith(el) {
    var q = new URLSearchParams(location.search)
    var value = el.value.trim()
    if (value) q.set(el.dataset.nav, value); else q.delete(el.dataset.nav)
    if (q.toString() === new URLSearchParams(location.search).toString()) return
    var s = q.toString()
    location.assign(location.pathname + (s ? '?' + s : ''))
  }
  document.addEventListener('change', function (e) {
    var el = e.target.closest('[data-nav]')
    if (el && !el.dataset.navOn) navWith(el)
  })
  var searchTimer = null
  document.addEventListener('keydown', function (e) {
    var el = e.target.closest('[data-nav][data-nav-on="enter"]')
    if (!el) return
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); navWith(el); return }
    if (e.key === 'Escape') { el.value = ''; clearTimeout(searchTimer); navWith(el); return }
    clearTimeout(searchTimer)
    searchTimer = setTimeout(function () { navWith(el) }, 600)
  })
  document.addEventListener('keydown', function (e) {
    if (e.key !== '/' || e.target.closest('input, textarea, select, [contenteditable]')) return
    var search = $('[data-nav-on="enter"]')
    if (search) { e.preventDefault(); search.focus(); search.select() }
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

  /* ── Job log: live tail over SSE, bounded DOM, follow toggle, copy ──────── */
  var LOG_DOM_LINES = 5000
  function wireJobLog() {
    var section = $('#log')
    if (!section) return
    var view = $('#log-view'), empty = $('#log-empty'), count = $('#log-count')
    var followBtn = $('[data-action="log-follow"]', section), copyBtn = $('[data-action="log-copy"]', section)
    var sourceBadge = $('#log-source'), truncatedBadge = $('#log-truncated')
    var jobId = section.dataset.jobId, lastSeq = Number(section.dataset.lastSeq || 0)
    var following = followBtn.getAttribute('aria-pressed') === 'true'
    var es = null

    function setFollow(on) {
      following = on
      followBtn.setAttribute('aria-pressed', on ? 'true' : 'false')
      if (on) view.scrollTop = view.scrollHeight
    }
    function lineNode(l) {
      var span = document.createElement('span')
      span.className = 'log-line'
      span.dataset.seq = String(l.seq)
      span.dataset.at = l.at
      var m = /T(\d{2}:\d{2}:\d{2})/.exec(l.at)
      span.innerHTML = '<span class="log-time">' + esc(m ? m[1] : l.at) + '</span><span class="log-text">' + esc(l.line) + '</span>\n'
      return span
    }
    function append(lines) {
      if (!lines.length) return
      var frag = document.createDocumentFragment()
      lines.forEach(function (l) { if (l.seq > lastSeq) { frag.appendChild(lineNode(l)); lastSeq = l.seq } })
      view.appendChild(frag)
      var extra = view.children.length - LOG_DOM_LINES
      while (extra-- > 0) view.removeChild(view.firstElementChild)
      view.hidden = false
      empty.hidden = true
      count.textContent = view.children.length + ' lines'
      if (following) view.scrollTop = view.scrollHeight
    }
    function finish(info) {
      section.removeAttribute('data-live')
      section.dataset.complete = 'true'
      followBtn.disabled = true
      followBtn.dataset.tip = 'The log is complete'
      setFollow(false)
      if (info.truncated) truncatedBadge.hidden = false
      if (info.source === 'github') {
        sourceBadge.dataset.tone = 'accent'
        sourceBadge.textContent = 'source: GitHub'
        sourceBadge.dataset.tip = 'The log GitHub stores for this job: complete and authoritative'
      } else if (info.source === 'runner') {
        sourceBadge.dataset.tone = 'neutral'
        sourceBadge.textContent = 'source: runner'
        sourceBadge.dataset.tip = 'Captured from the runner container; GitHub did not hand out its log in time'
      } else {
        sourceBadge.dataset.tone = 'neutral'
        sourceBadge.textContent = view.children.length ? 'source: runner' : 'source: none'
      }
      if (info.replaced) {
        // GitHub's log replaced the live lines: reload the view from the start.
        api('GET', '/api/jobs/' + jobId + '/log?limit=' + LOG_DOM_LINES).then(function (res) {
          if (!res.ok) return
          view.textContent = ''
          lastSeq = 0
          append(res.lines)
          view.scrollTop = 0
          T.toast('info', 'Log replaced with the final one from GitHub')
        })
      }
    }
    function connectLog() {
      if (!window.EventSource || section.dataset.complete === 'true') return
      es = new EventSource('/api/jobs/' + jobId + '/log/stream?after=' + lastSeq)
      es.addEventListener('line', function (e) { try { append(JSON.parse(e.data).lines || []) } catch (err) { /* malformed batch: wait for the next */ } })
      es.addEventListener('end', function (e) {
        var info = {}
        try { info = JSON.parse(e.data) } catch (err) { /* keep defaults */ }
        es.close(); es = null
        finish(info)
      })
      es.onerror = function () { /* the browser reconnects; `after` is re-read on the next open */ es.close(); es = null; setTimeout(connectLog, 3000) }
    }
    // Scrolling up turns follow off; scrolling to the bottom turns it on again.
    view.addEventListener('scroll', function () {
      var atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 8
      if (!atBottom && following) setFollow(false)
      else if (atBottom && !following && !followBtn.disabled) setFollow(true)
    }, { passive: true })
    followBtn.addEventListener('click', function () { setFollow(!following) })
    copyBtn.addEventListener('click', function () {
      var text = Array.prototype.map.call(view.children, function (n) { return n.textContent.replace(/\n$/, '') }).join('\n')
      if (!navigator.clipboard) { T.toast('warning', 'Clipboard is not available in this browser'); return }
      navigator.clipboard.writeText(text).then(
        function () { T.toast('success', 'Copied ' + view.children.length + ' lines') },
        function (err) { T.toast('danger', 'Copy failed: ' + err.message) })
    })
    if (following) view.scrollTop = view.scrollHeight
    connectLog()
  }

  /* ── Boot ────────────────────────────────────────────────────────────────── */
  function boot() {
    if (!T) return
    wireSlots(document)
    wireChips(document)
    wireSettings()
    wireJobLog()
    connect()
    var side = $('.t-shell-side .t-sidebar')
    var main = $('.t-shell-main')
    if (side && main) scrollspy(side, main)
  }

  /* Sidebar scrollspy over the scrolling main column. The current section is the last one whose
     top passed the reference line; at the end of the page it is the last section, and a click on a
     sidebar link wins until the user scrolls again (sections that fit on one screen never cross the line). */
  function scrollspy(nav, scroller) {
    var links = $$('a[href^="#"]', nav)
    var sections = links.map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)) }).filter(Boolean)
    if (!sections.length) return
    var pinned = null
    function mark(target) {
      links.forEach(function (a) {
        if (a.getAttribute('href') === '#' + target.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current')
      })
    }
    function update() {
      if (pinned) { mark(pinned); pinned = null; return }
      var line = scroller.getBoundingClientRect().top + 24
      var atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2
      var current = sections[0]
      if (atEnd) current = sections[sections.length - 1]
      else sections.forEach(function (s) { if (s.getBoundingClientRect().top <= line) current = s })
      mark(current)
    }
    links.forEach(function (a) {
      a.addEventListener('click', function () {
        var target = document.getElementById(a.getAttribute('href').slice(1))
        if (target) { pinned = target; mark(target) }
      })
    })
    scroller.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    update()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot()
})()

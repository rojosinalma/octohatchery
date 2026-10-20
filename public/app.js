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

/* OctoHatchery dashboard — progressive enhancement. Vanilla, no build step.
   Every action calls the JSON API with fetch, reports the {ok, message} outcome as a toast and
   never reloads the page. An EventSource on /events/stream refreshes live blocks in place. */
(function () {
  'use strict'

  var T = window.Tailor
  var $ = function (sel, root) { return (root || document).querySelector(sel) }
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)) }
  var linesLabel = function (n) { return n + (n === 1 ? ' line' : ' lines') }
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
  // Loading state on a .t-btn: aria-busy draws the skin's spinner (the leading icon hides meanwhile, see app.css).
  function busy(btn, on) {
    if (!btn) return
    if (on) { btn.setAttribute('aria-busy', 'true'); btn.disabled = true } else { btn.removeAttribute('aria-busy'); btn.disabled = false }
  }
  // Loading state on a non-button element (list rows): aria-busy plus an explicit .t-spinner where `slot` points.
  function busySpinner(el, slot, on) {
    if (!el) return
    var old = $('.t-spinner', el); if (old) old.remove()
    if (on) {
      el.setAttribute('aria-busy', 'true')
      var sp = document.createElement('span'); sp.className = 't-spinner'; sp.dataset.size = 'sm'; sp.setAttribute('aria-hidden', 'true')
      ;(slot || el).prepend(sp)
    } else el.removeAttribute('aria-busy')
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
      wireImagePick(main)
    }).catch(function (err) { T.toast('warning', 'Could not refresh: ' + err.message) })
  }
  // Live blocks carry data-live="<event names>" and, when the page has more than one, data-partial="<name>":
  // a matching SSE event re-fetches `?partial=<name>` (default 1) and replaces that block alone.
  var pending = {}, deferred = {}
  // A field the user is editing inside the live block must not be swapped away: the refresh waits for blur.
  function editing(block) {
    var a = document.activeElement
    return Boolean(a && a !== document.body && block.contains(a) && a.matches('input, textarea, select, .t-number-step'))
  }
  function partialOf(block) { return block.dataset.partial || '1' }
  function refreshLive(name) {
    delete pending[name]
    var block = liveBlock(name)
    if (!block) return
    if (editing(block)) { deferred[name] = true; return }
    delete deferred[name]
    var q = new URLSearchParams(location.search); q.set('partial', name)
    refetch(location.pathname + '?' + q.toString()).then(function (html) {
      var tpl = document.createElement('template'); tpl.innerHTML = html.trim()
      var fresh = tpl.content.firstElementChild
      var current = liveBlock(name)
      if (!fresh || !current) return
      if (editing(current)) { deferred[name] = true; return }
      current.replaceWith(fresh)
      T.upgrade(fresh)
      wireSlots(fresh)
    }).catch(function () { /* next event retries */ })
  }
  function liveBlock(name) {
    return $$('[data-live]').filter(function (b) { return partialOf(b) === name })[0] || null
  }
  function scheduleLive(event) {
    $$('[data-live]').forEach(function (block) {
      if (block.dataset.live.split(/\s+/).indexOf(event) < 0) return
      var name = partialOf(block)
      if (pending[name]) clearTimeout(pending[name])
      pending[name] = setTimeout(function () { refreshLive(name) }, 300)
    })
  }
  // Leaving the edited field lets a deferred refresh through (after the cell's own save round-trip).
  document.addEventListener('focusout', function (e) {
    var block = e.target.closest && e.target.closest('[data-live]')
    if (!block) return
    var name = partialOf(block)
    if (deferred[name] && !pending[name]) pending[name] = setTimeout(function () { refreshLive(name) }, 400)
  })

  /* ── SSE ─────────────────────────────────────────────────────────────────── */
  function liveDot(status, tip) { var d = $('#live-dot'); if (d) { d.dataset.status = status; d.dataset.tip = 'Live updates: ' + tip } }
  function connect() {
    if (!window.EventSource) return
    var es = new EventSource('/events/stream')
    es.onopen = function () { liveDot('running', 'connected') }
    es.onerror = function () { liveDot('degraded', 'reconnecting') }
    ;['runner', 'job', 'slot', 'event', 'image'].forEach(function (name) {
      es.addEventListener(name, function (e) { scheduleLive(name); document.dispatchEvent(new CustomEvent('live:' + name, { detail: e.data })) })
    })
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
          var toolbar = btn.closest('.t-toolbar')
          var siblings = $$('[data-action="runs-on-apply"]', toolbar).filter(function (b) { return b !== btn })
          busy(btn, true)
          siblings.forEach(function (b) { b.disabled = true })
          return api('POST', '/api/repos/runs-on', { fullName: repo, mode: mode, type: type }).then(function (res) {
            busy(btn, false)
            siblings.forEach(function (b) { b.disabled = false })
            // Failure: GitHub's exact message, dialog stays open. Success: the buttons give way to the result and its link.
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
      busySpinner(btn, $('.t-list-trail', btn), true)
      return api('POST', '/api/repos/adopt', { fullName: name }).then(function (res) {
        toast(res)
        if (res.ok) { dlg.close(''); swapMain(); return }
        busySpinner(btn, null, false)
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
      return api('POST', '/api/runners/spawn', { type: btn.dataset.type, host: btn.dataset.host }).then(toast).then(function () { busy(btn, false); scheduleLive('slot') })
    },
    /* Images: a queued pull stays busy until the `image` event re-renders the matrix; in the template dialog the button becomes a badge. */
    'image-pull': function (btn) {
      busy(btn, true)
      return pullImage(btn.dataset.host, btn.dataset.reference).then(function (res) {
        toast(res)
        if (!res.ok) { busy(btn, false); return }
        if (btn.closest('dialog')) {
          var badge = document.createElement('span')
          badge.className = 't-badge'
          badge.dataset.tone = 'info'
          badge.textContent = 'queued on ' + btn.dataset.host
          btn.replaceWith(badge)
        } else scheduleLive('image')
      })
    },
    'image-pull-all': function (btn) {
      var hosts = (btn.dataset.hosts || '').split(',').filter(Boolean)
      if (!hosts.length) return
      busy(btn, true)
      return Promise.all(hosts.map(function (h) { return pullImage(h, btn.dataset.reference) })).then(function (results) {
        var failed = results.filter(function (r) { return !r.ok })
        if (failed.length) T.toast('danger', failed.map(function (r) { return r.message }).join('; '))
        else T.toast('success', 'Pull of ' + btn.dataset.reference + ' queued on ' + hosts.join(', '))
        busy(btn, false)
        scheduleLive('image')
      })
    },
  }
  function pullImage(host, reference) {
    return api('POST', '/api/hosts/' + encodeURIComponent(host) + '/images/pull', { reference: reference })
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
    f.elements.runAs.value = type && type.runAs ? type.runAs : 'image'
    T.sync(f.elements.runAs)
    f.elements.dockerCache.value = type && type.dockerCache ? type.dockerCache : 'none'
    T.sync(f.elements.dockerCache)
    if (!type) { syncTypeBadge(f); setImage(f, f.dataset.imageDefault || ''); return }
    f.elements.name.value = type.name
    syncTypeBadge(f)
    f.elements.description.value = type.description || ''
    setImage(f, type.image)
    f.elements.cpus.value = type.cpus
    f.elements.memoryMb.value = type.memoryMb
    f.elements.mounts.value = (type.mounts || []).join('\n')
    f.elements.env.value = Object.keys(type.env || {}).map(function (k) { return k + '=' + type.env[k] }).join('\n')
    f.elements.secretEnv.value = (type.secretEnv || []).join(', ')
    $$('input, select, textarea', f).forEach(function (el) { T.sync(el) })
    imageWarning(f)
  }

  /* ── Image picker: known images in a select, "Other…" reveals a text field; both write the hidden `image` ── */
  function setImage(form, value) {
    var pick = $('#tf-image-pick', form), other = $('#tf-image-other', form)
    var known = $$('option', pick).some(function (o) { return o.value && o.value === value })
    pick.value = known ? value : ''
    other.value = known ? '' : value
    form.elements.image.value = value
    T.sync(pick)
    showOther(form, !known)
    imageWarning(form)
  }
  function showOther(form, on) {
    var other = $('#tf-image-other', form)
    other.hidden = !on
    other.disabled = !on
    other.required = on
  }
  function wireImagePick(root) {
    $$('#tf-image-pick', root).forEach(function (pick) {
      if (pick.dataset.wired !== undefined) return
      pick.dataset.wired = ''
      var form = pick.closest('form'), other = $('#tf-image-other', form)
      pick.addEventListener('change', function () {
        var isOther = pick.value === ''
        showOther(form, isOther)
        form.elements.image.value = isOther ? other.value.trim() : pick.value
        if (isOther) other.focus()
        imageWarning(form)
      })
      other.addEventListener('input', function () { form.elements.image.value = other.value.trim(); imageWarning(form) })
      form.elements.name.addEventListener('input', function () { imageWarning(form) })
    })
  }
  // The picked image is missing on a host that has slots for this template: say so and offer a pull per host.
  function imageWarning(form) {
    var alert = $('#tf-image-alert', form); if (!alert) return
    var pick = $('#tf-image-pick', form), reference = form.elements.image.value
    var opt = $$('option', pick).filter(function (o) { return o.value && o.value === reference })[0]
    var missing = (opt && opt.dataset.missing || '').split(',').filter(Boolean)
    var slotHosts = {}
    try { slotHosts = JSON.parse(form.dataset.slotHosts || '{}') } catch (e) { /* no slots data */ }
    var withSlots = slotHosts[form.elements.name.value.trim()] || []
    var hosts = missing.filter(function (h) { return withSlots.indexOf(h) >= 0 })
    alert.hidden = hosts.length === 0
    if (!hosts.length) return
    $('#tf-image-alert-text', alert).textContent = 'Not on ' + hosts.join(', ') + ', where this template has slots. The first runner there pulls it before starting, which delays that job.'
    $('#tf-image-alert-actions', alert).innerHTML = hosts.map(function (h) {
      return '<button class="t-btn" data-size="sm" type="button" data-action="image-pull" data-host="' + esc(h) + '" data-reference="' + esc(reference) + '">'
        + '<svg class="t-icon" aria-hidden="true"><use href="/tailor/icons.svg#bi-arrow-repeat"/></svg> Pull on ' + esc(h) + '</button>'
    }).join('')
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
      // Grouped by owner (one header per account) when the repos span several accounts; the list arrives sorted by name.
      var owners = repos.map(function (r) { return r.fullName.split('/')[0] }).filter(function (o, i, a) { return a.indexOf(o) === i })
      var grouped = owners.length > 1, lastOwner = null
      list.innerHTML = repos.map(function (r) {
        var owner = r.fullName.split('/')[0]
        var head = grouped && owner !== lastOwner ? '<div class="t-list-group" data-owner="' + esc(owner) + '">' + esc(owner) + '</div>' : ''
        lastOwner = owner
        return head + '<button class="t-list-item" role="option" aria-selected="false" data-action="adopt-pick" data-repo="' + esc(r.fullName) + '" data-owner="' + esc(owner) + '" data-name="' + esc(r.fullName.toLowerCase()) + '"' + (r.adopted ? ' disabled data-adopted' : '') + '>'
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
    $$('#adopt-list .t-list-group[data-owner]', dlg).forEach(function (g) {
      g.hidden = !$$('#adopt-list [data-action="adopt-pick"]', dlg).some(function (b) { return b.dataset.owner === g.dataset.owner && !b.hidden })
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
        runAs: f.elements.runAs.value || 'image',
        // Only a Docker-in-Docker daemon has a store to keep; the API refuses the cache for other types.
        dockerCache: (f.elements.docker.value === 'dind' && f.elements.dockerCache.value) || 'none',
      }
      busy(submit, true)
      return api('PUT', '/api/runner-types/' + encodeURIComponent(name), payload).then(toast).then(function (res) {
        busy(submit, false)
        if (res.ok) { f.closest('dialog').close(''); swapMain() }
      })
    },
    // Add image: one reference from the select, pulled on every online host that lacks it.
    'image-add': function (f, submit) {
      var pick = f.elements.reference
      if (!pick) return
      var opt = pick.options[pick.selectedIndex]
      var hosts = (opt && opt.dataset.hosts || '').split(',').filter(Boolean)
      if (!hosts.length) return
      busy(submit, true)
      return Promise.all(hosts.map(function (h) { return pullImage(h, pick.value) })).then(function (results) {
        busy(submit, false)
        var failed = results.filter(function (r) { return !r.ok })
        if (failed.length) { T.toast('danger', failed.map(function (r) { return r.message }).join('; ')); return }
        T.toast('success', 'Pull of ' + pick.value + ' queued on ' + hosts.join(', '))
        f.closest('dialog').close('')
        scheduleLive('image')
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
          if (res.ok) scheduleLive('slot')
        })
      })
    })
  }

  /* ── Jobs filter: selects navigate on change, the search box on Enter (or after a pause) ── */
  // A filter, page or page-size change inside a live block swaps that block only (URL updated in place);
  // outside one, or when the partial fails, it is a plain navigation.
  function goTo(url, from) {
    var block = from && from.closest && from.closest('[data-live]')
    if (!block) { location.assign(url); return }
    var name = partialOf(block)
    var u = new URL(url, location.href)
    var q = new URLSearchParams(u.search); q.set('partial', name)
    var keepFocus = from.matches && from.matches('input[type=search]')
    refetch(u.pathname + '?' + q.toString()).then(function (html) {
      var tpl = document.createElement('template'); tpl.innerHTML = html.trim()
      var fresh = tpl.content.firstElementChild
      var current = liveBlock(name)
      if (!fresh || !current) { location.assign(url); return }
      history.replaceState(null, '', u.pathname + u.search)
      current.replaceWith(fresh)
      T.upgrade(fresh)
      wireSlots(fresh)
      if (keepFocus) { var again = $('input[type=search][data-nav]', fresh); if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length) } }
    }).catch(function () { location.assign(url) })
  }
  function navWith(el) {
    var q = new URLSearchParams(location.search)
    var value = el.value.trim()
    if (value) q.set(el.dataset.nav, value); else q.delete(el.dataset.nav)
    // A changed filter or page size starts over at the first page.
    if (el.dataset.navReset) q.delete(el.dataset.navReset)
    if (q.toString() === new URLSearchParams(location.search).toString()) return
    var s = q.toString()
    goTo(location.pathname + (s ? '?' + s : ''), el)
  }
  // Pager and quick-filter links inside a live block behave the same way.
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[href]')
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return
    var block = a.closest('[data-live]')
    if (!block || !a.closest('.t-pagination, .t-btn-group[data-role=filter], .jobs-pager, .jobs-chip')) return
    var u = new URL(a.href, location.href)
    if (u.pathname !== location.pathname) return
    e.preventDefault()
    goTo(u.pathname + u.search, a)
  })
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

  // Accounts served (github_accounts): the ticked boxes are the list. Delegated, so it survives a re-render of main.
  // Optimistic: the card badge flips at once, a refused save reverts box and badge; unticking the last account is
  // refused before anything is sent.
  document.addEventListener('change', function (e) {
    var accounts = e.target.closest('[data-accounts]'), box = e.target.closest('input[type=checkbox]')
    if (!accounts || !box) return
    var picked = $$('input[type=checkbox]', accounts).filter(function (b) { return b.checked }).map(function (b) { return b.value })
    if (!picked.length) { box.checked = true; T.toast('warning', 'Keep at least one account: with none ticked OctoHatchery would serve nothing'); return }
    var row = accounts.closest('.t-setting')
    var badge = function (on) {
      $$('.gh-install').filter(function (c) { return c.dataset.account.toLowerCase() === box.value.toLowerCase() }).forEach(function (c) {
        var b = $('.gh-served', c); c.dataset.allowed = on ? 'true' : 'false'
        if (b) { b.textContent = on ? 'served' : 'ignored'; b.dataset.tone = on ? 'success' : 'neutral' }
      })
    }
    badge(box.checked)
    row.dataset.state = 'saving'
    saveSetting('github_accounts', picked.join(',')).then(function (res) {
      row.dataset.state = res.ok ? 'saved' : 'failed'
      toast(res)
      if (!res.ok) { box.checked = !box.checked; badge(box.checked); return }
      var hint = $('.gh-accounts-default', row); if (hint) hint.remove()
    })
  })

  /* ── Job log: live tail over SSE, bounded DOM, follow toggle, copy, steps + folded groups ─ */
  var LOG_DOM_LINES = 5000
  // Group markers, the same rules as src/views/log-groups.ts: `##[group]`/`##[section]Starting:` open a group
  // (closing the one before), `##[endgroup]`/`##[section]Finishing:` close it, `##[error|warning|notice|debug]` tone a line.
  var LOG_OPEN_RE = /^##\[(?:group\]|section\]Starting: )(.*)$/, LOG_CLOSE_RE = /^##\[(?:endgroup\]|section\]Finishing: )/, LOG_TONE_RE = /^##\[(error|warning|notice|debug)\]/
  var LOG_TONES = { error: 'danger', warning: 'warning', notice: 'notice', debug: 'debug' }
  // Steps view rules, the same as src/views/log-steps.ts: shown markers, progress runs, blank lines.
  var LOG_MARK_RE = /^(##\[(?:error|warning|notice|debug|command)\]|\[command\])/, LOG_PROGRESS_RE = /^(?:Received \d+ of \d+|\d{1,3}(?:\.\d+)?%(?:\s|$)|.*\b\d{1,3}(?:\.\d+)?% \(\d+\/\d+\))/
  var LOG_MARK_KIND = { '##[error]': 'danger', '##[warning]': 'warning', '##[notice]': 'notice', '##[debug]': 'debug', '##[command]': 'cmd', '[command]': 'cmd' }
  // Icon and word in front of a marker line, the same as MARKS in src/views/job.tsx.
  var LOG_MARKS = { danger: ['bi-x-circle-fill', 'Error:'], warning: ['bi-exclamation-triangle', 'Warning:'], notice: ['bi-info-circle', 'Notice:'], debug: [null, 'Debug:'] }
  var LOG_TS_KEY = 'octohatchery.logTimestamps'
  function classifyLine(raw) {
    var text = plainText(raw), m = LOG_OPEN_RE.exec(text)
    if (m) return { kind: 'open', title: m[1].trim() || 'group' }
    if (LOG_CLOSE_RE.test(text)) return { kind: 'close' }
    m = LOG_TONE_RE.exec(text)
    if (m) return { kind: 'line', tone: LOG_TONES[m[1]] }
    return { kind: 'line' }
  }
  function lineView(raw) {
    var m = LOG_MARK_RE.exec(plainText(raw))
    if (!m) return { kind: 'text', raw: raw }
    var i = raw.indexOf(m[1])
    return { kind: LOG_MARK_KIND[m[1]], raw: i >= 0 ? raw.slice(0, i) + raw.slice(i + m[1].length) : raw }
  }
  // ANSI SGR → escaped HTML with known classes only, the same rules as src/views/log-ansi.ts.
  var ANSI_RE = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b|[\x00-\x08\x0b-\x1f\x7f]/g
  function sgr(s, params) {
    var n = { fg: s.fg, bg: s.bg, bold: s.bold, italic: s.italic, underline: s.underline }
    var codes = params === '' ? [0] : params.split(';').map(function (p) { return p === '' ? 0 : Number(p) })
    for (var i = 0; i < codes.length; i++) {
      var c = codes[i]
      if (c === 0) { n.fg = null; n.bg = null; n.bold = false; n.italic = false; n.underline = false }
      else if (c === 1) n.bold = true
      else if (c === 3) n.italic = true
      else if (c === 4) n.underline = true
      else if (c === 22) n.bold = false
      else if (c === 23) n.italic = false
      else if (c === 24) n.underline = false
      else if (c >= 30 && c <= 37) n.fg = c - 30
      else if (c >= 90 && c <= 97) n.fg = c - 90 + 8
      else if (c === 39) n.fg = null
      else if (c >= 40 && c <= 47) n.bg = c - 40
      else if (c >= 100 && c <= 107) n.bg = c - 100 + 8
      else if (c === 49) n.bg = null
      else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0
    }
    return n
  }
  function sgrClass(s) {
    return [s.fg !== null ? 'ansi-fg-' + s.fg : '', s.bg !== null ? 'ansi-bg-' + s.bg : '', s.bold ? 'ansi-bold' : '', s.italic ? 'ansi-italic' : '', s.underline ? 'ansi-underline' : ''].filter(Boolean).join(' ')
  }
  function ansiHtml(raw) {
    var out = '', state = { fg: null, bg: null, bold: false, italic: false, underline: false }, last = 0, m
    var push = function (text) { if (!text) return; var cls = sgrClass(state); out += cls ? '<span class="' + cls + '">' + esc(text) + '</span>' : esc(text) }
    ANSI_RE.lastIndex = 0
    while ((m = ANSI_RE.exec(raw))) {
      push(raw.slice(last, m.index))
      last = m.index + m[0].length
      if (m[2] === 'm' && m[1].indexOf('?') < 0) state = sgr(state, m[1])
    }
    push(raw.slice(last))
    return out
  }
  function icon(id, size) { return '<svg class="t-icon" aria-hidden="true"' + (size ? ' data-size="' + size + '"' : '') + '><use href="/tailor/icons.svg#' + id + '"></use></svg>' }
  function clock(at) { var m = /T(\d{2}:\d{2}:\d{2})/.exec(at); return m ? m[1] : at }
  function spanMs(a, b) { var x = Date.parse(a), y = Date.parse(b); return isNaN(x) || isNaN(y) ? 0 : Math.max(0, y - x) }
  function fmtDuration(ms) {
    var s = Math.round(ms / 1000)
    if (s < 60) return s + ' s'
    if (s < 3600) return Math.floor(s / 60) + ' min ' + (s % 60) + ' s'
    return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min'
  }
  // Opens every <details> around `el` (step, group) so it can be seen.
  function reveal(el) { for (var d = el && el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true }
  function wireJobLog() {
    var section = $('#log')
    if (!section) return
    var empty = $('#log-empty'), count = $('#log-count')
    var followBtn = $('[data-action="log-follow"]', section), copyBtn = $('[data-action="log-copy"]', section)
    var expandBtn = $('[data-action="log-expand"]', section), collapseBtn = $('[data-action="log-collapse"]', section)
    var tsBtn = $('[data-action="log-timestamps"]', section)
    var sourceBadge = $('#log-source'), truncatedBadge = $('#log-truncated')
    var jobId = section.dataset.jobId, lastSeq = Number(section.dataset.lastSeq || 0)
    var raw = section.dataset.raw === 'true'
    var following = followBtn.getAttribute('aria-pressed') === 'true'
    var es = null
    var view = $('#log-view')
    // Steps view state: the group still receiving lines per step body, the line count across the view, the last
    // progress line of the current run (replaced by the next one).
    var openGroups = {}, lineCount = $$('.log-line', view).length, lastProgress = null
    function scanOpenGroups() {
      openGroups = {}
      $$('details.log-step', view).forEach(function (st) {
        var body = $('.log-step-body', st), last = body && body.lastElementChild
        if (last && last.matches('details.log-group:not([data-closed])')) openGroups[st.dataset.number] = last
      })
    }
    if (!raw) scanOpenGroups()

    function setFollow(on) {
      following = on
      followBtn.setAttribute('aria-pressed', on ? 'true' : 'false')
      if (on) view.scrollTop = view.scrollHeight
    }
    // Number and time of a streamed line, the same markup as Gutter in src/views/job.tsx.
    function gutter(id, n, at) {
      return (id ? '<a class="log-num" href="#' + id + '" tabindex="-1">' + n + '</a>' : '<span class="log-num"></span>')
        + '<time class="log-ts" datetime="' + esc(at) + '" data-tip="' + esc(at) + '">' + esc(clock(at)) + '</time>'
    }
    function takeNumber(st) {
      if (!st) return null
      var n = Number(st.dataset.next || 1)
      st.dataset.next = String(n + 1)
      return n
    }
    function lineNode(l, tone, marker, st) {
      var span = document.createElement('span')
      span.className = 'log-line'
      span.dataset.seq = String(l.seq)
      span.dataset.at = l.at
      if (tone) span.dataset.tone = tone
      if (raw) {
        span.innerHTML = '<span class="log-time">' + esc(clock(l.at)) + '</span><span class="log-text">' + esc(plainText(l.line)) + '</span>\n'
        return span
      }
      if (marker) {
        span.dataset.marker = ''; span.hidden = true
        span.innerHTML = gutter(null, null, l.at) + '<span class="log-text">' + esc(plainText(l.line)) + '</span>\n'
        return span
      }
      var n = takeNumber(st), id = st && n !== null ? 'step-' + st.dataset.number + '-' + n : null
      if (id) { span.id = id; span.dataset.n = String(n) }
      var v = lineView(l.line), mark = LOG_MARKS[v.kind]
      if (v.kind === 'cmd') span.dataset.cmd = ''
      span.innerHTML = gutter(id, n, l.at)
        + (mark ? '<span class="log-mark">' + (mark[0] ? icon(mark[0], 'xs') : '') + esc(mark[1]) + '</span>' : '')
        + '<span class="log-text">' + ansiHtml(v.raw) + '</span>\n'
      return span
    }
    function groupNode(l, title, st) {
      var d = document.createElement('details')
      d.className = 'log-group'
      d.open = true
      var n = takeNumber(st), id = st && n !== null ? 'step-' + st.dataset.number + '-' + n : null
      d.innerHTML = '<summary class="log-summary"' + (id ? ' id="' + id + '" data-n="' + n + '"' : '') + '>' + gutter(id, n, l.at) + '<span class="log-chevron" aria-hidden="true"></span>'
        + '<span class="log-group-title">' + esc(title) + '</span><span class="log-group-meta t-muted"></span></summary>'
      d.dataset.first = l.at
      d.dataset.count = '0'
      return d
    }
    function updateMeta(g, at) {
      var n = Number(g.dataset.count || 0)
      $('.log-group-meta', g).textContent = n + ' lines · ' + fmtDuration(spanMs(g.dataset.first, at))
    }
    // The step a streamed line belongs to, the same rules as assignLines in src/views/log-steps.ts: the step GitHub
    // named for it; else by time, never back to an earlier step: a stamp a whole second past a later step's start
    // moves there, inside a start second only a step opener (`##[group]Run …`, `Post job cleanup.`,
    // `Cleaning up orphan processes`) moves on, to the step it names or the next started one. Before any step has a
    // start the running step takes the line. A page without step rows (raw) has none.
    var LOG_OPENER_RE = /^(?:##\[group\](Run .*)|Post job cleanup\.|Cleaning up orphan processes)\s*$/
    var curStep = null
    function stepStart(st) { return st.dataset.conclusion === 'skipped' ? NaN : Date.parse(st.dataset.started || '') }
    function stepFor(l) {
      var steps = $$('details.log-step', view)
      if (!steps.length) return null
      if (l.step !== undefined && l.step !== null) {
        var named = $('details.log-step[data-number="' + l.step + '"]', view)
        if (named) { if (!curStep || steps.indexOf(named) > steps.indexOf(curStep)) curStep = named; return named }
      }
      var idx = curStep ? steps.indexOf(curStep) : -1
      if (idx < 0) steps.forEach(function (st, i) { if (Number(st.dataset.count || 0) > 0) idx = i })
      if (idx < 0) idx = 0
      var t = Date.parse(l.at)
      if (!isNaN(t)) {
        for (var i = idx + 1; i < steps.length; i++) if (stepStart(steps[i]) + 1000 <= t) idx = i
        var op = LOG_OPENER_RE.exec(plainText(l.line))
        if (op) {
          var title = (op[1] || '').trim(), started = []
          for (var j = idx + 1; j < steps.length; j++) if (stepStart(steps[j]) <= t) started.push(j)
          var byName = title ? started.filter(function (k) { return $('.log-step-name', steps[k]).textContent === title })[0] : undefined
          if (byName !== undefined) idx = byName; else if (started.length) idx = started[0]
        }
      }
      if (isNaN(stepStart(steps[idx]))) steps.forEach(function (st, k) { if (st.dataset.status === 'in_progress' && k >= idx) idx = k })
      curStep = steps[idx]
      return curStep
    }
    // Error and warning badges on a step row, the same markup as StepTally in src/views/job.tsx.
    function tally(st, tone) {
      var kind = tone === 'danger' ? 'errors' : 'warnings'
      var b = $('.log-step-tally[data-kind="' + kind + '"]', st), n = b ? Number(b.textContent) + 1 : 1
      var word = tone === 'danger' ? (n === 1 ? 'error' : 'errors') : (n === 1 ? 'warning' : 'warnings')
      if (!b) {
        b = document.createElement('span')
        b.className = 't-badge log-step-tally'; b.dataset.tone = tone; b.dataset.size = 'xs'; b.dataset.kind = kind
        var at = kind === 'errors' ? $('.log-step-tally', st) || $('.log-step-count', st) : $('.log-step-count', st)
        at.parentNode.insertBefore(b, at)
      }
      b.innerHTML = icon(tone === 'danger' ? 'bi-x-circle-fill' : 'bi-exclamation-triangle', 'xs') + n
      b.dataset.tip = n + ' ' + word
    }
    function bumpStep(st, tone) {
      if (!st) return
      st.dataset.count = String(Number(st.dataset.count || 0) + 1)
      $('.log-step-count', st).textContent = linesLabel(+st.dataset.count)
      if (tone === 'danger' || tone === 'warning') tally(st, tone)
    }
    function closeGroup(key) {
      var g = openGroups[key]
      if (!g) return
      g.dataset.closed = ''
      // Earlier groups fold as they close; one holding an error stays open.
      if (g.dataset.tone !== 'danger') g.open = false
      delete openGroups[key]
    }
    function place(node, target) { target.appendChild(node); lineCount++ }
    function appendOne(l) {
      var m = classifyLine(l.line)
      if (raw) { place(lineNode(l, m.kind === 'line' ? m.tone : undefined), view); return }
      var text = plainText(l.line)
      if (text.trim() === '') return
      var st = stepFor(l)
      // A close marker belongs to the step whose group is still open, whatever its stamp says.
      if (m.kind === 'close' && (l.step === undefined || l.step === null)) Object.keys(openGroups).forEach(function (k) { var g = openGroups[k].closest('details.log-step'); if (g) st = g })
      var body = st ? $('.log-step-body', st) : view, key = st ? st.dataset.number : '-'
      var open = openGroups[key], into = open || body
      if (m.kind === 'line' && LOG_PROGRESS_RE.test(text.trim())) {
        if (lastProgress && lastProgress.parentNode === into) {
          // The new progress line takes the place (and the number) of the one it replaces.
          if (st) st.dataset.next = String(Number(lastProgress.dataset.n || st.dataset.next))
          var next = lineNode(l, m.tone, false, st); lastProgress.replaceWith(next); lastProgress = next; return
        }
        place(lineNode(l, m.tone, false, st), into); lastProgress = into.lastElementChild
        if (open) { open.dataset.count = String(Number(open.dataset.count || 0) + 1); updateMeta(open, l.at) }
        bumpStep(st, m.tone)
        return
      }
      lastProgress = null
      if (m.kind === 'open') {
        closeGroup(key)
        var g = groupNode(l, m.title, st)
        body.appendChild(g)
        openGroups[key] = g
        place(lineNode(l, undefined, true, st), g)
        updateMeta(g, l.at)
      } else if (m.kind === 'close') {
        if (open) { place(lineNode(l, undefined, true, st), open); updateMeta(open, l.at); closeGroup(key) }
        else place(lineNode(l, undefined, true, st), body)
      } else if (open) {
        place(lineNode(l, m.tone, false, st), open)
        open.dataset.count = String(Number(open.dataset.count || 0) + 1)
        if (m.tone === 'danger' || (m.tone === 'warning' && !open.dataset.tone)) { open.dataset.tone = m.tone; if (m.tone === 'danger') open.open = true }
        updateMeta(open, l.at)
        bumpStep(st, m.tone)
      } else { place(lineNode(l, m.tone, false, st), body); bumpStep(st, m.tone) }
    }
    // Drop the oldest lines past the cap; a group left without lines goes with them (step rows stay).
    function trim() {
      while (lineCount > LOG_DOM_LINES) {
        var first = $('.log-line', view)
        if (!first) break
        var group = first.closest('details.log-group')
        first.remove(); lineCount--
        if (group && !$('.log-line', group)) { Object.keys(openGroups).forEach(function (k) { if (openGroups[k] === group) delete openGroups[k] }); group.remove() }
      }
    }
    function append(lines) {
      if (!lines.length) return
      lines.forEach(function (l) { if (l.seq > lastSeq) { appendOne(l); lastSeq = l.seq } })
      trim()
      view.hidden = false
      empty.hidden = true
      count.textContent = linesLabel(lineCount)
      if (following) view.scrollTop = view.scrollHeight
      if (search) search.refresh()
    }
    function reset() {
      lastSeq = 0; openGroups = {}; lineCount = 0; lastProgress = null; curStep = null
      if (raw) view.textContent = ''
      else $$('details.log-step', view).forEach(function (st) {
        $('.log-step-body', st).textContent = ''; st.dataset.count = '0'; st.dataset.next = '1'
        $('.log-step-count', st).textContent = '0 lines'
        $$('.log-step-tally', st).forEach(function (b) { b.remove() })
      })
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
        sourceBadge.textContent = lineCount ? 'source: runner' : 'source: none'
      }
      if (info.replaced) {
        // GitHub's log replaced the live lines: the server re-renders the steps with the final lines and timestamps.
        if (raw) {
          api('GET', '/api/jobs/' + jobId + '/log?limit=' + LOG_DOM_LINES).then(function (res) {
            if (!res.ok) return
            reset(); append(res.lines); view.scrollTop = 0
            T.toast('info', 'Log replaced with the final one from GitHub')
          })
        } else rerender().then(function () { view.scrollTop = 0; focusFailure(); T.toast('info', 'Log replaced with the final one from GitHub') })
      }
    }
    // A `job` event (status, steps, conclusion changed): swap lead, outcome line, annotations and the steps view from
    // the server, keeping which steps the user opened or closed, then catch up on lines the stream delivered meanwhile.
    var rerendering = null
    function rerender() {
      if (raw) return Promise.resolve()
      if (rerendering) return rerendering
      rerendering = refetch('/jobs/' + jobId + '?partial=log').then(function (html) {
        var tpl = document.createElement('template'); tpl.innerHTML = html.trim()
        var fresh = tpl.content.firstElementChild
        if (!fresh) return
        var opened = {}
        $$('details.log-step', view).forEach(function (st) { opened[st.dataset.number] = st.open })
        ;['job-lead', 'job-outcome', 'log-annotations'].forEach(function (id) {
          var a = $('#' + id), b = $('#' + id, fresh)
          if (a && b) { a.replaceWith(b); T.upgrade(b) }
        })
        var nextView = $('#log-view', fresh)
        if (!nextView) return
        $$('details.log-step', nextView).forEach(function (st) { if (opened[st.dataset.number] !== undefined) st.open = opened[st.dataset.number] })
        view.replaceWith(nextView)
        view = nextView
        T.upgrade(view)
        lastProgress = null; curStep = null
        scanOpenGroups()
        lineCount = $$('.log-line', view).length
        count.textContent = linesLabel(lineCount)
        if (search) search.refresh()
        var rendered = Number(view.dataset.lastSeq || 0)
        if (rendered < lastSeq) {
          // lines the stream handed us after the server rendered: fetch and append them
          var missed = lastSeq; lastSeq = rendered
          return api('GET', '/api/jobs/' + jobId + '/log?after=' + rendered + '&limit=' + LOG_DOM_LINES).then(function (res) { if (res.ok) append(res.lines); else lastSeq = missed })
        }
        if (following) view.scrollTop = view.scrollHeight
      }).catch(function () { /* next event retries */ }).then(function () { rerendering = null })
      return rerendering
    }
    var jobTimer = null
    document.addEventListener('live:job', function (e) {
      if (raw) return
      var changed = null
      try { changed = JSON.parse(e.detail || 'null') } catch (err) { /* opaque: refresh anyway */ }
      if (changed && String(changed.id) !== String(jobId)) return
      clearTimeout(jobTimer)
      jobTimer = setTimeout(rerender, 300)
    })
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
    section.addEventListener('scroll', function (e) {
      if (e.target !== view) return
      var atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 8
      if (!atBottom && following) setFollow(false)
      else if (atBottom && !following && !followBtn.disabled) setFollow(true)
    }, { passive: true, capture: true })
    followBtn.addEventListener('click', function () { setFollow(!following) })
    // Copy takes every stored line in view, the hidden group markers included, as plain text without gutters.
    copyBtn.addEventListener('click', function () {
      var nodes = $$('.log-line', view)
      var text = nodes.map(function (n) { var t = $('.log-text', n); return (t ? t.textContent : n.textContent).replace(/\n$/, '') }).join('\n')
      if (!navigator.clipboard) { T.toast('warning', 'Clipboard is not available in this browser'); return }
      navigator.clipboard.writeText(text).then(
        function () { T.toast('success', 'Copied ' + linesLabel(nodes.length)) },
        function (err) { T.toast('danger', 'Copy failed: ' + err.message) })
    })
    if (expandBtn) expandBtn.addEventListener('click', function () { $$('details.log-step, details.log-group', view).forEach(function (d) { d.open = true }); if (search) search.refresh() })
    if (collapseBtn) collapseBtn.addEventListener('click', function () { $$('details.log-step', view).forEach(function (d) { d.open = false }); if (search) search.refresh() })

    // Timestamps: off by default, the choice kept in localStorage; CSS shows `.log-ts` while the section has the flag.
    function setTimestamps(on) {
      if (on) section.dataset.timestamps = ''; else section.removeAttribute('data-timestamps')
      if (tsBtn) tsBtn.setAttribute('aria-pressed', on ? 'true' : 'false')
      try { if (on) localStorage.setItem(LOG_TS_KEY, '1'); else localStorage.removeItem(LOG_TS_KEY) } catch (err) { /* private mode: not remembered */ }
    }
    if (tsBtn) {
      var tsOn = false
      try { tsOn = localStorage.getItem(LOG_TS_KEY) === '1' } catch (err) { /* private mode */ }
      setTimestamps(tsOn)
      tsBtn.addEventListener('click', function () { setTimestamps(tsBtn.getAttribute('aria-pressed') !== 'true') })
    }

    // Search over the lines of open steps: matches are wrapped in <mark> by DOM text nodes (never HTML), counted,
    // Enter / the arrows walk them. Bounded by the lines in the DOM (≤ LOG_DOM_LINES) and MAX_MARKS highlights.
    var search = raw ? null : wireLogSearch(section, function () { return view })

    // Line anchors: `#step-4-12` opens step 4 (and the group around the line), scrolls to it and marks it.
    function goToHash() {
      var id = decodeURIComponent(location.hash.slice(1))
      if (!/^step-\d+-\d+$/.test(id)) return false
      var el = document.getElementById(id)
      if (!el || !view.contains(el)) return false
      reveal(el)
      $$('[data-target]', view).forEach(function (x) { x.removeAttribute('data-target') })
      el.dataset.target = ''
      el.scrollIntoView({ block: 'center' })
      return true
    }
    // A failed job opens on its failed step, scrolled to the first error line.
    function focusFailure() {
      var st = $('details.log-step[data-conclusion="failure"]', view)
      var line = st && ($('.log-line[data-tone="danger"]:not([data-marker])', st) || $('.log-line:not([data-marker])', st))
      if (!line) return
      reveal(line)
      line.scrollIntoView({ block: 'center' })
    }
    window.addEventListener('hashchange', goToHash)
    if (!raw && !goToHash() && section.dataset.complete === 'true') focusFailure()
    if (following) view.scrollTop = view.scrollHeight
    connectLog()
  }

  /*
   * Log search: one input in the log toolbar, a match count and previous/next buttons. Lines of closed steps are not
   * searched (GitHub's rule); matches inside a closed group of an open step are, and the group opens on a jump.
   */
  function wireLogSearch(section, getView) {
    var input = $('#log-search', section)
    if (!input) return null
    var counter = $('#log-matches', section)
    var prevBtn = $('[data-action="log-search-prev"]', section), nextBtn = $('[data-action="log-search-next"]', section)
    var MAX_MARKS = 1000
    var marks = [], current = -1, timer = null
    function clear() {
      $$('mark.log-match', getView()).forEach(function (m) {
        var parent = m.parentNode
        parent.replaceChild(document.createTextNode(m.textContent), m)
        parent.normalize()
      })
      $$('.log-line[data-match]', getView()).forEach(function (l) { l.removeAttribute('data-match') })
      marks = []; current = -1
    }
    function highlight(textEl, needle) {
      var walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT), nodes = [], node, hit = false
      while ((node = walker.nextNode())) nodes.push(node)
      nodes.forEach(function (t) {
        var s = t.nodeValue, lower = s.toLowerCase(), i = lower.indexOf(needle), at = 0
        if (i < 0 || marks.length >= MAX_MARKS) return
        var frag = document.createDocumentFragment()
        while (i >= 0 && marks.length < MAX_MARKS) {
          if (i > at) frag.appendChild(document.createTextNode(s.slice(at, i)))
          var m = document.createElement('mark'); m.className = 'log-match'; m.textContent = s.slice(i, i + needle.length)
          frag.appendChild(m); marks.push(m); hit = true
          at = i + needle.length; i = lower.indexOf(needle, at)
        }
        if (at < s.length) frag.appendChild(document.createTextNode(s.slice(at)))
        t.parentNode.replaceChild(frag, t)
      })
      return hit
    }
    function show() {
      var q = input.value
      counter.hidden = !q
      counter.textContent = !q ? '' : marks.length >= MAX_MARKS ? MAX_MARKS + '+ matches' : marks.length === 1 ? '1 match' : marks.length + ' matches'
      if (q && current >= 0 && marks.length) counter.textContent = (current + 1) + ' of ' + counter.textContent
      prevBtn.disabled = nextBtn.disabled = marks.length === 0
    }
    function run() {
      clear()
      var needle = input.value.toLowerCase()
      if (needle) {
        $$('details.log-step[open] .log-line:not([data-marker]) .log-text', getView()).forEach(function (t) {
          if (highlight(t, needle)) t.closest('.log-line').dataset.match = ''
        })
      }
      input.dataset.ran = input.value
      show()
    }
    function jump(delta) {
      if (!marks.length) return
      if (current >= 0) marks[current].removeAttribute('data-current')
      current = (current + delta + marks.length) % marks.length
      var m = marks[current]
      m.dataset.current = ''
      reveal(m)
      m.scrollIntoView({ block: 'center' })
      show()
    }
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 150) })
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return
      e.preventDefault()
      clearTimeout(timer)
      if (input.dataset.ran !== input.value) run()
      jump(e.shiftKey ? -1 : 1)
    })
    prevBtn.addEventListener('click', function () { jump(-1) })
    nextBtn.addEventListener('click', function () { jump(1) })
    // Opening or closing a step changes what is searched.
    section.addEventListener('toggle', function (e) { if (input.value && e.target.matches && e.target.matches('details.log-step')) { clearTimeout(timer); timer = setTimeout(run, 50) } }, true)
    return { refresh: function () { if (input.value) run() } }
  }

  /* ── Boot ────────────────────────────────────────────────────────────────── */
  function boot() {
    if (!T) return
    wireSlots(document)
    wireChips(document)
    wireImagePick(document)
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

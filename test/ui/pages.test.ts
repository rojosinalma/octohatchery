import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { empty, full, makeService, type FixtureSet } from './fixtures'

const store: { data: FixtureSet } = { data: full }
mock.module('../../src/lib/service', () => ({ service: makeService(store) }))

const { ui } = await import('../../src/routes/ui')

const get = async (path: string) => {
  const res = await ui.handle(new Request(`http://localhost${path}`))
  return { res, body: await res.text() }
}

beforeEach(() => {
  store.data = full
})
afterEach(() => {
  store.data = full
})

const PAGES: [string, string, string][] = [
  ['/', 'Overview', 'Overview · OctoHatchery'],
  ['/jobs', 'Jobs', 'Jobs · OctoHatchery'],
  ['/repos', 'Repos', 'Repos · OctoHatchery'],
  ['/runner-types', 'Runner types', 'Runner types · OctoHatchery'],
  ['/hosts', 'Hosts', 'Hosts · OctoHatchery'],
  ['/events', 'Events', 'Events · OctoHatchery'],
  ['/settings', 'Settings', 'Settings · OctoHatchery'],
]

describe('layout', () => {
  test.each(PAGES)('%s renders 200 with the shell', async (path, h1, title) => {
    const { res, body } = await get(path)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(body.startsWith('<!doctype html>')).toBe(true)
    expect(body).toContain(`<title>${title}</title>`)
    expect(body).toContain(`<h1 class="t-page-title">${h1}</h1>`)
    expect((body.match(/<h1\b/g) ?? []).length).toBe(1)
    // navbar with seven links in the agreed order, the active one marked
    expect((body.match(/class="t-navbar-link"/g) ?? []).length).toBe(7)
    expect(body.match(/class="t-navbar-link" href="([^"]+)"/g)?.map((m) => m.slice(m.indexOf('href="') + 6, -1))).toEqual(['/', '/repos', '/jobs', '/runner-types', '/hosts', '/events', '/settings'])
    expect(body).toMatch(new RegExp(`href="${path.replace('/', '\\/')}" aria-current="page"`))
    // tailor head snippet, app assets, favicon, toasts, confirm dialog
    expect(body).toContain('managed by tailor')
    expect(body).toContain('href="/tailor/tokens.css"')
    expect(body).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg"')
    expect(body).toContain('href="/public/app.css"')
    expect(body).toContain('src="/public/app.js"')
    expect(body).toContain('id="t-toasts"')
    expect(body).toContain('id="t-confirm"')
    // switcher: mode toggle first in the footer end
    expect(body).toMatch(/<div class="t-footer-end"><div data-tailor-pickers="mode"><\/div>/)
    expect(body).toContain('v0.1.0-test')
    // never browser-native tooltips
    expect(body).not.toMatch(/\stitle="/)
  })

  test('theme settings seed the flash cache; unsafe values are dropped', async () => {
    store.data = { ...full, settings: { ...full.settings, ui_mode: '</script><script>alert(1)' } }
    const { body } = await get('/')
    expect(body).toContain('"skin":"pico"')
    expect(body).toContain('"palette":"nord"')
    expect(body).not.toContain('alert(1)')
  })

  test('the concept word stays out of the dashboard; tables say runners', async () => {
    const { body } = await get('/')
    expect(body).not.toMatch(/tentacle/)
    expect(body).toContain('Runners')
  })
})

describe('overview', () => {
  test('hosts, leader badge, slot bars, runners table with kill buttons', async () => {
    const { body } = await get('/')
    // one Hosts card, one section per host with its slots underneath
    expect((body.match(/<section class="t-card"/g) ?? []).length).toBe(1)
    expect(body).toContain('href="/hosts">All hosts')
    const sections = [...body.matchAll(/<section class="host-section" data-name="([^"]+)"/g)].map((m) => m[1])
    expect(sections).toEqual(['node-a', 'node-b'])
    expect(body).toContain('leader')
    expect(body).toContain('>Docker unreachable<')
    const nodeA = body.slice(body.indexOf('data-name="node-a"'), body.indexOf('data-name="node-b"'))
    expect(nodeA).toContain('<table class="t-table host-slots"')
    expect(nodeA).toContain('style="--t-value: 25%"')
    expect(nodeA).toContain('1/4')
    expect(nodeA).not.toContain('No slots on this host')
    expect(body).toContain('id="runners-table"')
    expect(body).toContain('generic-node-a-3')
    // only live runners are listed
    expect(body).not.toContain('generic-node-a-2')
    expect(body).toContain('data-action="kill"')
    expect(body).toContain('href="/jobs/7"')
    // user-controlled text is escaped
    expect(body).toContain('build &lt;main&gt;')
    expect(body).not.toContain('>build <main><')
  })

  test('a host without slots says so and points at Runner types', async () => {
    store.data = { ...full, slots: full.slots.filter((s) => s.host === 'node-a') }
    const { body } = await get('/')
    const nodeB = body.slice(body.indexOf('data-name="node-b"'))
    expect(nodeB).toContain('No slots on this host.')
    expect(nodeB).toContain('href="/runner-types">Set some under Runner types</a>')
    expect(nodeB).not.toContain('host-slots')
  })

  test('empty state explains self-registration', async () => {
    store.data = empty
    const { res, body } = await get('/')
    expect(res.status).toBe(200)
    expect(body).toContain('No hosts yet')
    expect(body).toContain('registers itself on boot')
    expect(body).not.toContain('id="hosts-table"')
  })

  test('?partial=1 returns only the live block', async () => {
    const { res, body } = await get('/?partial=1')
    expect(res.status).toBe(200)
    expect(body.trim().startsWith('<div id="overview-live" data-live="runner slot"')).toBe(true)
    expect(body).not.toContain('<html')
    expect(body).not.toContain('<h1')
    expect(body).toContain('id="runners-table"')
  })
})

describe('jobs', () => {
  test('table with status badges, filter group and GitHub links', async () => {
    const { body } = await get('/jobs')
    expect(body).toContain('id="jobs-table"')
    expect(body).toContain('data-role="filter"')
    expect(body).toContain('href="https://github.com/acme/widgets/actions/runs/70/job/700"')
    expect(body).toContain('>in progress<')
    expect(body).toContain('>failure<')
    expect(body).toContain('id="jobs-repo"')
    expect(body).toContain('<option value="acme/widgets"')
  })

  test('columns: runner, status, job, repo, queued, duration, run', async () => {
    const { body } = await get('/jobs')
    const heads = [...body.matchAll(/<th[^>]*>(?:<button>)?([A-Za-z ]+?)\s*(?:<span class="t-sort-icon">)?<\//g)].map((m) => m[1]!.trim())
    expect(heads).toEqual(['Runner', 'Status', 'Job', 'Repo', 'Queued', 'Duration', 'Run'])
    // the runner name links to the job page; a job without a runner shows a dash
    expect(body).toContain('<a class="t-mono" href="/jobs/7" data-tip="Open the job and its log">generic-node-a-3</a>')
    expect(body).not.toContain('>Labels<')
  })

  test('status select, search box and quick filters keep the other params', async () => {
    const { body } = await get('/jobs?status=completed&repo=acme%2Fwidgets&q=te')
    expect(body).toContain('data-job-id="8"')
    expect(body).not.toContain('data-job-id="7"')
    expect(body).toMatch(/<select class="t-select"[^>]*data-nav="status"[^>]*id="jobs-status">/)
    expect(body).toContain('<option value="completed" selected>Completed</option>')
    expect(body).toMatch(/<input class="t-input"[^>]*type="search"[^>]*data-nav="q"[^>]*value="te"/)
    expect(body).toMatch(/<span class="t-toolbar-spacer"><\/span><div class="t-btn-group" role="group" data-role="filter" aria-label="Quick filters">/)
    expect(body).toMatch(/href="\/jobs\?repo=acme%2Fwidgets&status=completed&q=te&running=1" aria-pressed="false">Running now/)
    expect(body).toMatch(/href="\/jobs\?repo=acme%2Fwidgets&status=completed&q=te&failed=1" aria-pressed="false">Failed/)
    expect(body).toMatch(/since=2026-\d\d-\d\dT[^"]+" aria-pressed="false" data-preset="24h">Last 24 h/)
    expect(body).toMatch(/data-preset="7d">This week/)
  })

  test('quick filters are pressed when active, and the link then clears them', async () => {
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString()
    const { body } = await get(`/jobs?running=1&since=${encodeURIComponent(since)}`)
    expect(body).toMatch(/href="\/jobs\?since=[^"]+" aria-pressed="true">Running now/)
    expect(body).toMatch(/href="\/jobs\?running=1" aria-pressed="true" data-preset="24h">Last 24 h/)
    expect(body).toMatch(/aria-pressed="false" data-preset="7d">This week/)
    // a bad `since` is ignored
    expect((await get('/jobs?since=yesterday')).res.status).toBe(200)
  })

  test('unknown status is ignored, empty filter result has a clear link', async () => {
    const { body } = await get('/jobs?status=bogus&repo=none%2Fnone')
    expect(body).toContain('No jobs match this filter')
    expect(body).toContain('href="/jobs"')
  })

  test('empty state and partial', async () => {
    store.data = empty
    expect((await get('/jobs')).body).toContain('No jobs yet')
    store.data = full
    const { body } = await get('/jobs?partial=1&running=1')
    expect(body.trim().startsWith('<div id="jobs-live" data-live="job"')).toBe(true)
    expect(body).not.toContain('<html')
    expect(body).toContain('data-job-id="7"')
    expect(body).not.toContain('data-job-id="8"')
    expect(body).toContain('generic-node-a-3')
  })

  test('job names link to the job page', async () => {
    const { body } = await get('/jobs')
    expect(body).toContain('href="/jobs/7"')
    expect(body).toContain('href="/jobs/8"')
  })
})

describe('job page', () => {
  test('live job: header, runner facts, lines escaped, follow on, source runner (live)', async () => {
    const { res, body } = await get('/jobs/7')
    expect(res.status).toBe(200)
    expect(body).toContain('<title>build &lt;main&gt; · OctoHatchery</title>')
    expect(body).toContain('<h1 class="t-page-title">build &lt;main&gt;</h1>')
    expect(body).toContain('class="t-page-back" href="/jobs"')
    expect(body).toContain('href="https://github.com/acme/widgets/actions/runs/70/job/700"')
    expect(body).toContain('generic-node-a-3')
    expect(body).toContain('>node-a<')
    expect(body).toContain('>in progress<')
    expect(body).toContain('id="log" data-job-id="7" data-last-seq="2" data-live="log" data-complete="false"')
    expect(body).toContain('source: runner (live)')
    expect(body).toContain('data-action="log-follow" aria-pressed="true"')
    expect(body).toContain('data-action="log-copy"')
    expect(body).toContain('class="log-text">##[group]Run &lt;script&gt;alert(1)&lt;/script&gt;<')
    expect(body).toContain('class="log-time">10:00:32<')
    expect(body).toContain('id="log-truncated" hidden')
    expect(body).toContain('<pre class="t-code-pre log-view" id="log-view"')
    expect(body).not.toMatch(/\stitle="/)
    expect(body).not.toMatch(/style="(?!--t-)/)
  })

  test('finished job with GitHub log: complete, follow disabled, truncated badge shown', async () => {
    const { body } = await get('/jobs/8')
    expect(body).toContain('data-complete="true"')
    expect(body).not.toContain('data-live="log"')
    expect(body).toContain('source: GitHub')
    expect(body).toContain('aria-pressed="false" disabled')
    expect(body).toMatch(/id="log-truncated"(?! hidden)/)
    expect(body).toContain('>failure<')
  })

  test('no lines yet: empty state says the runner has not started', async () => {
    store.data = { ...full, logs: {} }
    const { body } = await get('/jobs/7')
    expect(body).toContain('Waiting for the runner to start…')
    expect(body).toContain('id="log-view"')
    expect(body).toMatch(/id="log-view"[^>]*hidden/)
    expect(body).toContain('data-last-seq="0"')
  })

  test('unknown job is a 404 with a reason, bad id a 400', async () => {
    expect((await get('/jobs/999')).res.status).toBe(404)
    expect((await get('/jobs/999')).body).toContain('job 999 is unknown')
    expect((await get('/jobs/abc')).res.status).toBe(400)
  })
})

describe('repos', () => {
  test('adopt form, adopted table, runs-on dialog with snippet per type', async () => {
    const { body } = await get('/repos')
    expect(body).toContain('id="adopt-form"')
    expect(body).toContain('placeholder="owner/name"')
    expect(body).toContain('id="repos-table"')
    expect(body).toContain('acme/widgets')
    expect(body).not.toContain('acme/old')
    expect(body).toContain('data-action="unadopt"')
    expect(body).toContain('data-action="runs-on"')
    // no native validation bubble: tailor draws the feedback
    expect(body).toMatch(/<form class="t-toolbar page-toolbar adopt-form" id="adopt-form"[^>]*novalidate>/)
    // jobs count links to the filtered jobs page; zero is muted text
    expect(body).toContain('<a class="t-mono" href="/jobs?repo=acme%2Fwidgets" data-tip="Jobs of this repo">2</a>')
    expect(body).toMatch(/data-repo="acme\/polled"[^>]*>[\s\S]*?<td class="t-col-num"><span class="t-muted">0<\/span><\/td>/)
    // three labelled actions in one non-wrapping cluster; the webhook button says what it does
    const widgets = body.slice(body.indexOf('data-repo="acme/widgets"'), body.indexOf('data-repo="acme/polled"'))
    expect(widgets).toContain('<div class="t-cluster row-actions" data-gap="1">')
    expect(widgets).toContain('data-action="webhook" data-repo="acme/widgets"')
    expect(widgets).toContain('Repair webhook')
    expect(widgets).toContain('> Unadopt</button>')
    expect(body).toContain('Add webhook')
    expect(body).toContain('id="runs-on-dlg"')
    expect(body).toContain('class="t-code-copy"')
    expect(body).toMatch(/runs-on<\/span>: \[<span class="t-tok-str">self-hosted<\/span>, <span class="t-tok-str">generic<\/span>\]/)
    expect(body).toContain('data-mode="pr"')
    expect(body).toContain('data-mode="commit"')
  })

  test('with a GitHub App the webhook button is disabled and explained', async () => {
    store.data = { ...full, githubAuth: 'app' }
    const { body } = await get('/repos')
    expect(body).toContain('<span data-tip="Covered by the GitHub App" class="row-action-disabled"><button class="t-btn" data-size="sm" data-variant="ghost" disabled>')
    expect(body).toContain('>via App<')
    expect(body).not.toContain('data-action="webhook"')
  })

  test('empty state', async () => {
    store.data = empty
    const { body } = await get('/repos')
    expect(body).toContain('No repos adopted')
    expect(body).toContain('id="adopt-form"')
  })
})

describe('hosts', () => {
  test('table with specs, leader badge, slots per host and the add-host dialog', async () => {
    const { body } = await get('/hosts')
    expect(body).toContain('id="hosts-table"')
    const heads = [...body.matchAll(/<th[^>]*>(?:<button>)?([A-Za-z ]+?)\s*(?:<span class="t-sort-icon">)?<\//g)].map((m) => m[1]!.trim())
    expect(heads).toEqual(['Host', 'Docker', 'CPUs', 'Memory', 'OS', 'Docker version', 'App version', 'Last seen', 'Slots'])
    expect(body).toContain('leader')
    expect(body).toContain('<td class="t-col-num">8</td>')
    expect(body).toContain('32.0 GiB')
    expect(body).toContain('Ubuntu 24.04.1 LTS')
    expect(body).toContain('27.3.1')
    expect(body).toContain('v0.1.0-test</span>')
    expect(body).toContain('>1/4</a>')
    // node-b has not reported yet
    const nodeB = body.slice(body.indexOf('data-name="node-b"'))
    expect(nodeB).toContain('data-tip="Reported by the node on its next heartbeat"')
    expect(nodeB).toContain('>0/1</a>')
    // the dialog explains how a host joins and offers the .env skeleton
    expect(body).toContain('data-dialog-open="add-host-dlg"')
    expect(body).toContain('id="add-host-dlg"')
    for (const key of ['MODE=cluster', 'HOST_NAME=', 'DATABASE_URL=', 'GITHUB_AUTH=', 'GITHUB_WEBHOOK_SECRET=', 'PUBLIC_URL=']) expect(body).toContain(key)
    expect(body).toContain('docs/operations.md#cluster-mode')
    expect(body).toContain('class="t-code-copy"')
  })

  test('empty state names the action', async () => {
    store.data = empty
    const { body } = await get('/hosts')
    expect(body).toContain('No hosts yet')
    expect(body).toMatch(/t-empty-actions"><button class="t-btn" data-variant="primary" data-dialog-open="add-host-dlg">/)
    expect(body).not.toContain('id="hosts-table"')
  })
})

describe('runner types', () => {
  test('types table, edit dialog form, slots matrix with spawn buttons', async () => {
    const { body } = await get('/runner-types')
    expect(body).toContain('id="types-table"')
    expect(body).toContain('ghcr.io/example/runner:1')
    expect(body).toContain('General purpose &lt;builds&gt;')
    expect(body).toContain('NPM_TOKEN')
    expect(body).toContain('data-action="type-edit"')
    expect(body).toContain('id="type-form"')
    for (const name of ['name', 'description', 'labels', 'image', 'cpus', 'memoryMb', 'mounts', 'env', 'secretEnv']) expect(body).toContain(`name="${name}"`)
    // environment before mounts, in the table and in the dialog
    expect(body.indexOf('<th class="t-col-num">Environment</th>')).toBeLessThan(body.indexOf('<th class="t-col-num">Mounts</th>'))
    expect(body.indexOf('id="tf-env"')).toBeLessThan(body.indexOf('id="tf-mounts"'))
    // labels: chip input over a hidden field, fixed badges first
    expect(body).toContain('<div class="chip-input" id="tf-labels-chips" data-chips-for="tf-labels">')
    expect(body).toMatch(/data-fixed data-tip="Always added by OctoHatchery">self-hosted<\/span>/)
    expect(body).toContain('id="tf-labels-type"')
    expect(body).toContain('<input type="hidden" id="tf-labels" name="labels"')
    expect(body).toContain('class="chip-entry" id="tf-labels-entry"')
    expect(body).toContain('id="slots-matrix"')
    expect(body).toContain('data-slot-type="generic" data-slot-host="node-a"')
    expect(body).toContain('value="4"')
    expect(body).toContain('data-action="spawn"')
    // offline host: spawn disabled
    expect(body).toMatch(/data-host="node-b"\s+disabled/)
  })

  test('empty state', async () => {
    store.data = empty
    const { body } = await get('/runner-types')
    expect(body).toContain('No runner types')
    expect(body).toContain('No hosts yet')
  })
})

describe('events', () => {
  test('audit table and partial', async () => {
    const { body } = await get('/events')
    expect(body).toContain('id="events-table"')
    expect(body).toContain('repo.adopt')
    expect(body).toContain('mcp:assistant')
    expect(body).toContain('webhookId')
    const partial = (await get('/events?partial=1')).body
    expect(partial.trim().startsWith('<div id="events-live" data-live="event"')).toBe(true)
    expect(partial).not.toContain('<html')
  })

  test('empty state', async () => {
    store.data = empty
    expect((await get('/events')).body).toContain('No events yet')
  })
})

describe('settings', () => {
  test('rows per setting with labels, help and auto-save hooks; theme selects; sidebar', async () => {
    const { body } = await get('/settings')
    expect(body).toContain('class="t-shell-side"')
    expect(body).toContain('class="t-settings')
    for (const key of ['poll_interval_s', 'stale_runner_minutes', 'retention_days', 'sse_max_clients', 'sse_idle_s', 'log_level', 'custom_flag']) expect(body).toContain(`data-setting="${key}"`)
    // labels are human-readable, durations are .t-duration in seconds (5 min → 300)
    expect(body).toContain('>Poll interval<')
    expect(body).toMatch(/data-setting="stale_runner_minutes" data-value="300" data-scale="60"/)
    expect(body).toContain('class="t-help"')
    expect(body).toContain('class="t-setting-state"')
    expect(body).not.toContain('>Save<')
    // theme keys are not rows; the selects live here
    expect(body).not.toContain('data-setting="ui_skin"')
    expect(body).toContain('data-tailor-pickers="skin palette"')
    expect(body).toContain('Custom flag')
    expect(body).toContain('class="t-page-back"')
  })
})

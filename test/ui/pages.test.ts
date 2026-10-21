import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { empty, full, githubMulti, githubOk, githubStatus, job87Set, makeService, type FixtureSet } from './fixtures'

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
  ['/templates', 'Templates', 'Templates · OctoHatchery'],
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
    expect(body.match(/class="t-navbar-link" href="([^"]+)"/g)?.map((m) => m.slice(m.indexOf('href="') + 6, -1))).toEqual(['/', '/repos', '/jobs', '/templates', '/hosts', '/events', '/settings'])
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

  test('the concept word stays out of the dashboard; copy says runners', async () => {
    const { body } = await get('/')
    expect(body).not.toMatch(/tentacle/)
    expect(body).toContain('A runner in a slot shows the job it works on')
  })
})

describe('overview', () => {
  test('hosts as columns, one-line header, slot circles with the runner in its slot', async () => {
    const { body } = await get('/')
    // one Hosts card (plus the Recent jobs card), one column per host with its slots underneath
    expect((body.match(/<section class="t-card"/g) ?? []).length).toBe(2)
    expect(body).toContain('href="/hosts">All hosts')
    expect(body).toContain('<div class="t-card-body host-list" data-hosts="2">')
    // two hosts split the card in halves (3 of 6 tracks each)
    expect([...body.matchAll(/<section class="host-section" data-name="[^"]+" data-span="(\d)"/g)].map((m) => m[1])).toEqual(['3', '3'])
    expect(body).not.toContain('slots used / total')
    expect(body).toContain('aria-label="About slots"')
    const sections = [...body.matchAll(/<section class="host-section" data-name="([^"]+)"/g)].map((m) => m[1])
    expect(sections).toEqual(['node-a', 'node-b'])
    const nodeA = body.slice(body.indexOf('data-name="node-a"'), body.indexOf('data-name="node-b"'))
    const nodeB = body.slice(body.indexOf('data-name="node-b"'), body.indexOf('id="recent-jobs"'))
    // leader badge: xs, accent, spaced from the name; no `online` / `Docker ok` badges
    expect(nodeA).toContain('<span class="t-badge host-leader" data-tone="accent" data-size="xs"')
    expect(nodeA).not.toContain('>online<')
    expect(nodeA).not.toContain('Docker ok')
    expect(nodeB).not.toContain('host-leader" data-tone="accent"')
    expect(nodeB).toContain('>offline</span>')
    expect(nodeB).toContain('>Docker unreachable</span>')
    // specs line: parts the node has not reported are left out
    expect(nodeA).toMatch(/host-specs">8 CPU · 32 GB · <span>Docker 27\.3\.1<\/span> · seen <time/)
    expect(nodeB).toMatch(/host-specs">seen <time/)
    // summary line and circles: 1 of 4 busy, warning only when full
    expect(nodeA).toContain('<p class="t-small host-summary">1 of 4 slots busy</p>')
    expect(nodeA).toContain('aria-label="generic on node-a: 1 of 4 slots used"')
    expect((nodeA.match(/<span class="slot-pill"/g) ?? []).length).toBe(4)
    expect((nodeA.match(/<span class="slot-pill" data-busy="true"/g) ?? []).length).toBe(1)
    expect((nodeA.match(/<span class="slot-pill" data-tip="Free slot">/g) ?? []).length).toBe(3)
    expect(nodeA).not.toContain('t-progress')
    expect(nodeA).toContain('href="/templates#generic" class="t-mono t-small slot-type" data-tip="Template">generic</a>')
    expect(nodeA).toContain('<a class="t-mono host-name" href="/hosts#node-a" data-tip="Host details">node-a</a>')
    expect(nodeA).not.toContain('No slots on this host')
    // the busy runner sits in its slot: capsule with kill, job label linking to the job, the filled circle last;
    // it comes before the free circles so the row grows to the left
    const seat = nodeA.slice(nodeA.indexOf('<span class="slot-seat"'), nodeA.indexOf('data-tip="Free slot"'))
    expect(seat).toContain('<span class="slot-seat" data-state="busy" data-runner-id="3">')
    expect(seat).toMatch(/data-action="kill" data-id="3" data-name="generic-node-a-3" data-job="build <main>"/)
    expect(seat).toContain('aria-label="Kill runner generic-node-a-3"')
    expect(seat).toContain('<a class="slot-seat-label" href="/jobs/7" data-tip="generic-node-a-3 · build <main> · acme/widgets">')
    expect(seat).toContain('<span class="slot-seat-job">build &lt;main&gt;</span>')
    expect(seat).toContain('<span class="slot-seat-repo t-muted">widgets</span>')
    expect(seat).toMatch(/<\/a><span class="slot-pill" data-busy="true" data-state="busy"><\/span><\/span><span class="slot-pill" $/)
    // the exited runner holds no slot; there is no separate Runners table any more
    expect(body).not.toContain('data-runner-id="2"')
    expect(body).not.toContain('id="runners-table"')
    // user-controlled text is escaped
    expect(body).not.toContain('>build <main><')
  })

  test('slot states: idle and spawning runners, a claimed slot without its runner yet', async () => {
    const live = (id: number, state: 'idle' | 'spawning', createdAt: string) => ({ ...full.runners[0]!, id, name: `generic-node-a-${id}`, state, jobId: null, repo: null, jobName: null, createdAt })
    store.data = { ...full, slots: [{ host: 'node-a', type: 'generic', count: 5, used: 4, free: 1 }], runners: [full.runners[0]!, live(5, 'spawning', '2026-10-19T10:02:00Z'), live(4, 'idle', '2026-10-19T10:01:00Z')] }
    const { body } = await get('/?partial=1')
    // seats in creation order: busy, idle, spawning; then one claimed circle and one free circle
    expect([...body.matchAll(/class="slot-seat" data-state="([a-z]+)"/g)].map((m) => m[1])).toEqual(['busy', 'idle', 'spawning'])
    expect(body).toContain('<span class="slot-seat-job">waiting for a job</span>')
    expect(body).toContain('<span class="slot-seat-job">starting</span>')
    expect(body).toContain('href="/jobs?runner=generic-node-a-4"')
    expect(body).toMatch(/<span class="slot-pill" data-busy="true" data-tip="Claimed, runner starting"><\/span><span class="slot-pill" data-tip="Free slot"><\/span><\/span>/)
    expect((body.match(/<span class="slot-pill"/g) ?? []).length).toBe(5)
  })

  test('a host without slots says so and points at Templates', async () => {
    store.data = { ...full, slots: full.slots.filter((s) => s.host === 'node-a') }
    const { body } = await get('/')
    const nodeB = body.slice(body.indexOf('data-name="node-b"'))
    expect(nodeB).toContain('No slots on this host. <a href="/templates">Set some under Templates</a>')
    expect(nodeB).not.toContain('host-slots')
    expect(nodeB).not.toContain('slot-pill')
  })

  test('a full host is a warning; more than 12 slots fall back to the bar', async () => {
    store.data = { ...full, slots: [{ host: 'node-a', type: 'generic', count: 2, used: 2, free: 0 }, { host: 'node-b', type: 'big', count: 16, used: 4, free: 12 }] }
    const { body } = await get('/')
    const nodeA = body.slice(body.indexOf('data-name="node-a"'), body.indexOf('data-name="node-b"'))
    const nodeB = body.slice(body.indexOf('data-name="node-b"'))
    expect(nodeA).toContain('<p class="t-small host-summary" data-tone="warning">2 of 2 slots busy</p>')
    expect(nodeB).not.toContain('class="slot-pill"')
    expect(nodeB).toContain('style="--t-value: 25%"')
    // the busy runner of node-a still sits in its slot while the other slot reads as claimed
    expect(nodeA).toContain('data-runner-id="3"')
    expect((nodeA.match(/data-tip="Claimed, runner starting"/g) ?? []).length).toBe(1)
    expect(nodeB).toContain('4/16')
  })

  test('hosts split each row equally: at most 3 per row, rows filled evenly', async () => {
    const { hostRows, hostSpans } = await import('../../src/views/overview')
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => hostRows(n))).toEqual([[1], [2], [3], [2, 2], [3, 2], [3, 3], [3, 2, 2], [3, 3, 2]])
    expect(hostSpans(5)).toEqual([2, 2, 2, 3, 3])
    expect(hostSpans(1)).toEqual([6])
    expect(hostRows(0)).toEqual([])
    const many = Array.from({ length: 5 }, (_, i) => ({ ...full.hosts[0]!, name: `node-${i}`, isLeader: i === 0 }))
    const { body } = await get('/?partial=1')
    expect(body).toContain('data-hosts="2"')
    store.data = { ...full, hosts: many }
    const five = (await get('/?partial=1')).body
    expect(five).toContain('<div class="t-card-body host-list" data-hosts="5">')
    expect([...five.matchAll(/data-span="(\d)"/g)].map((m) => m[1])).toEqual(['2', '2', '2', '3', '3'])
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
    expect(body).toContain('class="slot-seat"')
    expect(body).not.toContain('id="recent-jobs"')
  })

  test('Recent jobs card: own live block, prefixed filters, total counter, All jobs link with the same filters', async () => {
    const { body } = await get('/?j_status=completed&j_repo=acme%2Fwidgets')
    expect(body).toContain('<section class="t-card" id="recent-jobs" data-live="job runner" data-partial="jobs"')
    expect(body).toContain('Recent jobs <span class="t-counter" data-tip="Jobs matching the filter">1</span>')
    expect(body).toContain('href="/jobs?repo=acme%2Fwidgets&status=completed" data-tip="The Jobs page with the same filters">')
    // toolbar controls navigate under the j_ prefix and reset the page
    expect(body).toMatch(/<select class="t-select"[^>]*data-nav="j_status" data-nav-reset="j_page" id="recent-status">/)
    expect(body).toMatch(/<option value="completed" selected>Completed<\/option>/)
    expect(body).toMatch(/<input class="t-input"[^>]*name="j_q" data-nav="j_q" data-nav-on="enter" data-nav-reset="j_page"/)
    expect(body).toMatch(/href="\/\?j_repo=acme%2Fwidgets&j_status=completed&j_running=1" aria-pressed="false">Running now/)
    // the table carries the filtered row only; the repo link stays on the Overview
    expect(body).toContain('id="recent-table"')
    expect(body).toContain('data-job-id="8"')
    expect(body).not.toContain('data-job-id="7"')
    expect(body).toContain('href="/?j_repo=acme%2Fwidgets&j_status=completed">acme/widgets</a>')
    // two jobs fit one page of ten: the pager still shows the picker
    expect(body).toContain('id="recent-per"')
  })

  test('?partial=jobs returns the card alone; a filtered empty card clears back to /', async () => {
    const { body } = await get('/?partial=jobs&j_q=zzz')
    expect(body.trim().startsWith('<section class="t-card" id="recent-jobs"')).toBe(true)
    expect(body).not.toContain('id="overview-live"')
    expect(body).toContain('No jobs match this filter')
    expect(body).toContain('<a class="t-btn" href="/">Clear filters</a>')
  })

  test('Recent jobs pager: page numbers with the j_ prefix, the picker offers 10/20/50/All', async () => {
    store.data = { ...full, jobs: Array.from({ length: 23 }, (_, i) => ({ ...full.jobs[1]!, id: 100 + i, name: `job ${i}` })) }
    const { body } = await get('/?j_page=2')
    expect(body).toContain('<div class="t-cluster jobs-pager" data-gap="3" data-align="center" id="recent-pager">')
    expect(body).toContain('<nav class="t-pagination" aria-label="Pages" data-size="sm">')
    expect(body).toContain('<a class="t-page-link" href="/" aria-label="Previous page">«</a>')
    expect(body).toContain('<a class="t-page-link" href="/">1</a>')
    expect(body).toContain('<a class="t-page-link" href="/?j_page=2" aria-current="page">2</a>')
    expect(body).toContain('<a class="t-page-link" href="/?j_page=3">3</a>')
    expect(body).toContain('<a class="t-page-link" href="/?j_page=3" aria-label="Next page">»</a>')
    expect(body).toContain('11–20 of 23')
    expect(body).toContain('id="recent-per"')
    expect(body).toContain('<option value="10" selected>Last 10</option>')
    expect(body).toContain('<option value="all">All</option>')
    expect((body.match(/data-job-id="/g) ?? []).length).toBe(10)
    // page 3: 3 rows, next disabled; All: 23 rows on one page; a page past the end lands on the last one
    const p3 = (await get('/?j_page=3')).body
    expect((p3.match(/data-job-id="/g) ?? []).length).toBe(3)
    expect(p3).toContain('<a class="t-page-link" aria-disabled="true" aria-label="Next page">»</a>')
    const all = (await get('/?j_per=all')).body
    expect((all.match(/data-job-id="/g) ?? []).length).toBe(23)
    expect(all).toContain('<option value="all" selected>All</option>')
    expect(((await get('/?j_per=20')).body.match(/data-job-id="/g) ?? []).length).toBe(20)
    expect((await get('/?j_page=99')).body).toContain('href="/?j_page=3" aria-current="page">3</a>')
    // a size outside the allowed set falls back to the default
    expect(((await get('/?j_per=7')).body.match(/data-job-id="/g) ?? []).length).toBe(10)
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
    // the pager with its per-page select is part of the live block
    expect(body).toContain('id="jobs-pager"')
    expect(body).toMatch(/<select class="t-select"[^>]*data-nav="per" data-nav-reset="page" id="jobs-per">/)
    expect(body).toContain('<option value="25" selected>25 per page</option>')
  })

  test('/jobs pages 25 at a time; page and per stay in filter links; a filter change resets the page', async () => {
    store.data = { ...full, jobs: Array.from({ length: 60 }, (_, i) => ({ ...full.jobs[1]!, id: 100 + i, name: `job ${i}` })) }
    const { body } = await get('/jobs?page=2&failed=1')
    expect((body.match(/data-job-id="/g) ?? []).length).toBe(25)
    expect(body).toContain('26–50 of 60')
    expect(body).toContain('<a class="t-page-link" href="/jobs?failed=1&page=2" aria-current="page">2</a>')
    expect(body).toContain('<a class="t-page-link" href="/jobs?failed=1&page=3" aria-label="Next page">»</a>')
    // the quick filter links drop the page; Running now adds its flag, Failed clears itself
    expect(body).toMatch(/href="\/jobs\?running=1&failed=1" aria-pressed="false">Running now/)
    expect(body).toMatch(/href="\/jobs" aria-pressed="true">Failed/)
    const per10 = (await get('/jobs?per=10&page=6')).body
    expect((per10.match(/data-job-id="/g) ?? []).length).toBe(10)
    expect(per10).toContain('51–60 of 60')
    expect(per10).toContain('<a class="t-page-link" aria-disabled="true">…</a>')
    expect(per10).toContain('<a class="t-page-link" href="/jobs?per=10&page=5" aria-label="Previous page">«</a>')
    expect(per10).toContain('<option value="10" selected>10 per page</option>')
  })

  test('job names link to the job page', async () => {
    const { body } = await get('/jobs')
    expect(body).toContain('href="/jobs/7"')
    expect(body).toContain('href="/jobs/8"')
  })

  test('?runner= filters the list and shows a chip with a clear link that keeps the other params', async () => {
    const { body } = await get('/jobs?runner=generic-node-a-3&status=in_progress')
    expect(body).toContain('data-job-id="7"')
    expect(body).not.toContain('data-job-id="8"')
    expect(body).toContain('<span class="t-badge filter-chip" data-tone="accent" data-variant="outline" id="jobs-runner-chip">runner: <span class="t-mono">generic-node-a-3</span>')
    expect(body).toContain('<a class="chip-remove" href="/jobs?status=in_progress" aria-label="Clear runner filter generic-node-a-3" data-tip="Clear runner filter">×</a>')
    expect(body).toMatch(/href="\/jobs\?status=in_progress&running=1&runner=generic-node-a-3" aria-pressed="false">Running now/)
    expect((await get('/jobs')).body).not.toContain('id="jobs-runner-chip"')
    expect((await get('/jobs?runner=nobody')).body).toContain('No jobs match this filter')
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
    // gutter: a line number linking to the line's anchor, the time of day (shown with "Show timestamps") with the full stamp on hover
    expect(body).toContain('<span class="log-line" id="step-1-1" data-seq="1" data-at="2026-10-19T10:00:31.000000000Z" data-n="1"><a class="log-num" href="#step-1-1" tabindex="-1">1</a><time class="log-ts" datetime="2026-10-19T10:00:31.000000000Z" data-tip="2026-10-19T10:00:31.000000000Z">10:00:31</time><span class="log-text">Current runner version: 2.3</span>')
    expect(body).toContain('data-action="log-timestamps" aria-pressed="false"')
    expect(body).toContain('<input class="t-input" type="search" id="log-search"')
    expect(body).toContain('id="log-truncated" hidden')
    expect(body).toContain('<div class="log-steps" id="log-view"')
    // outcome line under the title and one row per step: the finished one closed, the running one open with a spinner
    expect(body).toContain('<p class="job-outcome t-muted" id="job-outcome"><span>running</span> <time class="t-time" data-relative datetime="2026-10-19T10:00:30Z">')
    expect(body).toMatch(/<details class="log-step" data-number="1" data-status="completed" data-conclusion="success" data-started="2026-10-19T10:00:30Z" data-completed="2026-10-19T10:00:40Z" data-count="1" data-next="3"><summary class="log-step-head"><span class="log-step-chevron" aria-hidden="true"><svg[^>]*><use href="\/tailor\/icons.svg#bi-chevron-right"><\/use><\/svg><\/span><span class="log-step-icon" data-tone="success" role="img" aria-label="succeeded" data-tip="Succeeded"><svg[^>]*><use href="\/tailor\/icons.svg#bi-check-circle-fill">/)
    expect(body).toContain('<span class="log-step-name">Set up job</span><span class="log-step-count t-muted t-small">1 line</span><span class="log-step-duration t-muted" data-tip="2026-10-19T10:00:30Z → 2026-10-19T10:00:40Z">10s</span>')
    expect(body).toMatch(/<details class="log-step" open data-number="2" data-status="in_progress" data-started="2026-10-19T10:00:40Z" data-count="0" data-next="1"><summary class="log-step-head">.*?<span class="t-spinner log-step-icon" data-size="sm" data-tone="accent" role="img" aria-label="running"/)
    // the unterminated group is open (still receiving lines), its marker line hidden, its title escaped
    expect(body).toContain('<details class="log-group" open data-first="2026-10-19T10:00:32.000000000Z" data-count="0"><summary class="log-summary" id="step-1-2" data-n="2">')
    expect(body).toContain('<span class="log-group-title">Run &lt;script&gt;alert(1)&lt;/script&gt;</span><span class="log-group-meta t-muted">0 lines · 0 s</span>')
    // the `job` partial carries lead, outcome and the steps view for the browser to swap by id
    const live = (await get('/jobs/7?partial=log')).body
    expect(live.startsWith('<div id="job-live"><span class="t-page-lead" id="job-lead">')).toBe(true)
    expect(live).toContain('<p class="job-outcome t-muted" id="job-outcome">')
    expect(live).toContain('<div class="log-steps" id="log-view"')
    expect(live).not.toContain('<html')
    expect(body).toMatch(/<span class="log-line" data-seq="2"[^>]*data-marker="" hidden>/)
    expect(body).toContain('data-action="log-expand"')
    expect(body).toContain('data-action="log-collapse"')
    expect(body).toContain('href="/jobs/7?raw=1"')
    expect(body).not.toMatch(/\stitle="/)
    expect(body).not.toMatch(/style="(?!--t-)/)
  })

  test('grouped log: closed groups fold, an error group opens and is toned, lines outside stay flat', async () => {
    const at = (s: string) => `2026-10-19T08:00:${s}Z`
    const text = ['Set up job', '##[group]Run build', 'ok', '##[endgroup]', '##[group]Run tests', '##[error]boom', '##[endgroup]', '##[warning]slow', 'done']
    store.data = { ...full, logs: { 8: { ...full.logs[8]!, lines: text.map((line, i) => ({ seq: i + 1, at: at(String(10 + i)), line })) } } }
    const { body } = await get('/jobs/8')
    // the fixture's lines (08:00:10–18) all fall in the first step's window; the failed step opens, the others are closed
    expect(body).toMatch(/<details class="log-step" data-number="1"[^>]*data-count="5" data-next="8">/)
    expect(body).toMatch(/<details class="log-step" open data-number="2" data-status="completed" data-conclusion="failure"[^>]*data-count="0" data-next="1">/)
    expect(body).toMatch(/<details class="log-step" data-number="3"[^>]*data-count="0" data-next="1">/)
    // the step row counts its errors and warnings
    expect(body).toContain('<span class="t-badge log-step-tally" data-tone="danger" data-size="xs" data-kind="errors" data-tip="1 error">')
    expect(body).toContain('<span class="t-badge log-step-tally" data-tone="warning" data-size="xs" data-kind="warnings" data-tip="1 warning">')
    expect(body).toContain('<p class="job-outcome t-muted" id="job-outcome"><span>failed</span> <time class="t-time" data-relative datetime="2026-10-19T08:05:10Z">19 Oct 2026, 08:05 UTC</time> in <span class="t-mono">5m 0s</span></p>')
    // a group header is a numbered line of its own; its content continues the numbering, the hidden markers do not count
    expect(body).toMatch(/<details class="log-group" data-closed="" data-first="[^"]+" data-count="1"><summary class="log-summary" id="step-1-2" data-n="2"><a class="log-num" href="#step-1-2" tabindex="-1">2<\/a><time class="log-ts"[^>]*>08:00:11<\/time><span class="log-chevron" aria-hidden="true"><\/span><span class="log-group-title">Run build<\/span><span class="log-group-meta t-muted">1 line · 2 s<\/span><\/summary>/)
    expect(body).toContain('id="step-1-3" data-seq="3"')
    expect(body).toMatch(/<details class="log-group" open data-tone="danger" data-closed=""[^>]*><summary class="log-summary" id="step-1-4"/)
    // ##[error] / ##[warning]: toned, icon and word in front, marker stripped
    expect(body).toMatch(/<span class="log-line" id="step-1-5" data-seq="6"[^>]*data-tone="danger"><a class="log-num"[^>]*>5<\/a><time[^>]*>[^<]*<\/time><span class="log-mark"><svg[^>]*><use href="\/tailor\/icons.svg#bi-x-circle-fill"><\/use><\/svg>Error:<\/span><span class="log-text">boom<\/span>/)
    expect(body).toMatch(/<span class="log-line" id="step-1-6" data-seq="8"[^>]*data-tone="warning">.*?Warning:<\/span><span class="log-text">slow<\/span>/)
    expect(body).toMatch(/<span class="log-line" id="step-1-7" data-seq="9" data-at="[^"]+" data-n="7"><a class="log-num" href="#step-1-7" tabindex="-1">7<\/a><time class="log-ts"[^>]*>08:00:18<\/time><span class="log-text">done<\/span>/)
    expect((body.match(/<details class="log-group"/g) ?? []).length).toBe(2)
    // every stored line is in the DOM (markers hidden), so Copy keeps the markers
    expect((body.match(/<span class="log-line"/g) ?? []).length).toBe(9)
    expect((body.match(/data-marker="" hidden/g) ?? []).length).toBe(4)
  })

  test('steps view: blank lines dropped, progress runs collapsed, commands styled, lines placed by step window', async () => {
    const lines = [
      ['2026-10-19T08:00:05Z', 'before the first step'],
      ['2026-10-19T08:00:12Z', '##[command]/usr/bin/git version'],
      ['2026-10-19T08:00:13Z', ''],
      ['2026-10-19T08:00:14Z', 'Received 0 of 100 (0.0%), 0.0 MBs/sec'],
      ['2026-10-19T08:00:15Z', 'Received 100 of 100 (100.0%), 1.0 MBs/sec'],
      ['2026-10-19T08:00:21Z', 'first of step 2'],
      ['2026-10-19T08:04:00Z', '##[error]boom'],
      ['2026-10-19T08:05:01Z', 'complete job'],
      ['2026-10-19T08:09:00Z', 'after the last step'],
    ].map(([at, line], i) => ({ seq: i + 1, at: at!, line: line! }))
    store.data = { ...full, logs: { 8: { ...full.logs[8]!, lines } } }
    const { body } = await get('/jobs/8')
    expect(body).toMatch(/<details class="log-step" data-number="1"[^>]*data-count="3"/)
    expect(body).toMatch(/<details class="log-step" open data-number="2"[^>]*data-count="2"/)
    expect(body).toMatch(/<details class="log-step" data-number="3"[^>]*data-count="2"/)
    // line numbers restart at 1 in every step
    expect(body).toContain('id="step-2-1" data-seq="6"')
    expect(body).toContain('id="step-3-1" data-seq="8"')
    expect(body).toContain('<span class="log-line" id="step-1-2" data-seq="2" data-at="2026-10-19T08:00:12Z" data-n="2" data-cmd=""><a class="log-num" href="#step-1-2" tabindex="-1">2</a><time class="log-ts" datetime="2026-10-19T08:00:12Z" data-tip="2026-10-19T08:00:12Z">08:00:12</time><span class="log-text">/usr/bin/git version</span>')
    expect(body).not.toContain('data-seq="3"')
    expect(body).not.toContain('data-seq="4"')
    expect(body).toContain('data-seq="5"')
    expect(body).toContain('<span class="log-step-count t-muted t-small">3 lines</span>')
    expect((body.match(/<span class="log-line"/g) ?? []).length).toBe(7)
    // no steps known yet: one pseudo-step "Log" holds everything and takes the job's state
    store.data = { ...full, jobs: full.jobs.map((j) => (j.id === 8 ? { ...j, steps: [] } : j)), logs: { 8: { ...full.logs[8]!, lines } } }
    const pseudo = (await get('/jobs/8')).body
    expect(pseudo).toMatch(/<details class="log-step" open data-number="0" data-status="completed" data-conclusion="failure" data-started="2026-10-19T08:00:10Z" data-completed="2026-10-19T08:05:10Z" data-count="7" data-next="8"><summary class="log-step-head">.*?<span class="log-step-name">Log<\/span>/)
    expect((pseudo.match(/<details class="log-step"/g) ?? []).length).toBe(1)
  })

  test('job 87 from the flat log: Standard holds the lint output and its error, Complete job one line; annotations above the steps', async () => {
    store.data = await job87Set()
    const { body } = await get('/jobs/87')
    const step = (n: number) => {
      const from = body.indexOf(`data-number="${n}"`)
      const to = body.indexOf('<details class="log-step"', from)
      return body.slice(from, to < 0 ? undefined : to)
    }
    // the failed step opens with its error badge; counts are the lines in view (blank lines dropped)
    expect(body).toMatch(/<details class="log-step" open data-number="4" data-status="completed" data-conclusion="failure"[^>]*data-count="\d+"/)
    expect(step(4)).toContain('<span class="log-step-name">Standard</span><span class="t-badge log-step-tally" data-tone="danger" data-size="xs" data-kind="errors" data-tip="1 error">')
    expect(step(4)).toContain('<span class="log-text">Process completed with exit code 1.</span>')
    expect(step(4)).toContain('spec/unit_78_spec.rb:72:47')
    expect(body).toMatch(/<details class="log-step" data-number="9"[^>]*data-count="1" data-next="2">/)
    // GitHub's command echo: cyan bold, escaped, a known class only
    expect(body).toContain('<span class="log-text"><span class="ansi-fg-6 ansi-bold">bundle exec standardrb</span></span>')
    // annotations: level icon, message linked to its line in the log, path:line; GitHub's `.github` placeholder shows no path
    expect(body).toContain('<div class="log-annotations" id="log-annotations"><h3 class="log-annotations-title">Annotations <span class="t-counter">2</span></h3>')
    expect(body).toMatch(/<li class="log-annotation" data-level="failure"><span class="log-annotation-icon" data-tone="danger" role="img" aria-label="Error">.*?<a class="log-annotation-msg" href="#step-4-\d+" data-tip="Show the line in the log">Process completed with exit code 1.<\/a><\/span><\/li>/)
    expect(body).toContain('<b class="log-annotation-title">Style/GlobalVars</b><span class="log-annotation-msg">Do not introduce global variables.</span></span><span class="log-annotation-where t-mono t-muted t-small">lib/widgets/part_21.rb:45</span>')
    // the partial carries the annotations for the live re-render
    expect((await get('/jobs/87?partial=log')).body).toContain('id="log-annotations"')
    // every numbered line links to its own anchor
    const ids = [...body.matchAll(/ id="(step-\d+-\d+)"/g)].map((m) => m[1]!)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids.slice(0, 50)) expect(body).toContain(`href="#${id}"`)
    expect(body).not.toContain('\x1b')
    expect(body).not.toMatch(/\stitle="/)
  })

  test('?raw=1 renders the flat view with a Steps link and no step buttons', async () => {
    const { body } = await get('/jobs/7?raw=1')
    expect(body).toContain('id="log" data-job-id="7" data-last-seq="2" data-live="log" data-complete="false" data-raw="true"')
    expect(body).not.toContain('<details')
    expect(body).toMatch(/<span class="log-line" data-seq="2" data-at="[^"]+"><span class="log-time">10:00:32<\/span><span class="log-text">##\[group\]Run/)
    expect(body).not.toContain('data-action="log-expand"')
    expect(body).toContain('href="/jobs/7" data-tip="Back to the steps view">')
    expect(body).toContain('class="log-time">10:00:32<')
    expect(body).not.toContain('log-step')
    expect((await get('/jobs/7?raw=yes')).res.status).toBe(400)
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
  test('adopt button and dialog (no free-text form), adopted table, runs-on dialog with snippet per type', async () => {
    const { body } = await get('/repos')
    expect(body).not.toContain('id="adopt-form"')
    expect(body).not.toContain('placeholder="owner/name"')
    expect(body).toContain('data-action="adopt-open"')
    expect(body).toContain('<dialog class="t-dialog" id="adopt-dlg"')
    expect(body).toContain('<input class="t-input" type="search" id="adopt-search"')
    expect(body).toContain('id="adopt-list"')
    expect(body).toContain('id="repos-table"')
    expect(body).toContain('acme/widgets')
    expect(body).not.toContain('acme/old')
    expect(body).toContain('data-action="unadopt"')
    expect(body).toContain('data-action="runs-on"')
    // jobs count links to the filtered jobs page; zero is muted text
    expect(body).toContain('<a class="t-mono" href="/jobs?repo=acme%2Fwidgets" data-tip="Jobs of this repo">2</a>')
    expect(body).toMatch(/data-repo="acme\/polled"[^>]*>[\s\S]*?<td class="t-col-num"><span class="t-muted">0<\/span><\/td>/)
    // three icon-only actions in one non-wrapping cluster, each with a tooltip and a label
    const widgets = body.slice(body.indexOf('data-repo="acme/widgets"'), body.indexOf('data-repo="acme/polled"'))
    expect(widgets).toContain('<div class="t-cluster row-actions" data-gap="1">')
    expect(widgets).toContain('data-icon="only" data-tip="runs-on snippet and workflow change" aria-label="runs-on" data-action="runs-on"')
    expect(widgets).toMatch(/data-action="webhook" data-repo="acme\/widgets" data-tip="Repair webhook[^"]*" aria-label="Repair webhook"/)
    expect(widgets).toContain('data-tone="danger" data-icon="only" data-tip="Unadopt" aria-label="Unadopt" data-action="unadopt"')
    expect(widgets).not.toContain('> Unadopt</button>')
    expect(body).toMatch(/aria-label="Add webhook"/)
    expect((widgets.match(/<svg class="t-icon"/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(body).toContain('id="runs-on-dlg"')
    expect(body).toContain('class="t-code-copy"')
    expect(body).toMatch(/runs-on<\/span>: \[<span class="t-tok-str">self-hosted<\/span>, <span class="t-tok-str">generic<\/span>\]/)
    expect(body).toContain('data-mode="pr"')
    expect(body).toContain('data-mode="commit"')
  })

  test('with a GitHub App the webhook button is disabled and explained', async () => {
    store.data = { ...full, githubAuth: 'app' }
    const { body } = await get('/repos')
    expect(body).toContain('<span data-tip="Webhook covered by the GitHub App" class="row-action-disabled"><button class="t-btn" data-size="sm" data-variant="ghost" data-icon="only" aria-label="Add webhook" disabled>')
    expect(body).toContain('>GitHub App<')
    expect(body).not.toContain('>polling<')
    expect(body).not.toContain('data-action="webhook"')
  })

  test('empty state', async () => {
    store.data = empty
    const { body } = await get('/repos')
    expect(body).toContain('No repos adopted')
    expect(body).toContain('data-action="adopt-open"')
  })
})

describe('github status', () => {
  test('no banner when nothing is missing', async () => {
    const { body } = await get('/')
    expect(body).not.toContain('id="github-banner"')
  })

  test('banner on every page names the missing permissions and links to the GitHub tab', async () => {
    store.data = { ...full, github: githubStatus }
    for (const path of ['/', '/jobs', '/repos', '/settings']) {
      const { body } = await get(path)
      expect(body).toContain('<div class="t-alert page-banner" data-tone="warning" role="alert" id="github-banner">')
      expect(body).toContain('GitHub access lacks actions:write, workflows:write')
      expect(body).toContain('href="/settings#github"')
    }
  })

  test('banner when no source is configured', async () => {
    store.data = { ...full, github: { ...githubOk, ok: false, source: 'none', permissions: [], missing: [] } }
    const { body } = await get('/jobs')
    expect(body).toContain('GITHUB_AUTH=none')
  })

  test('settings tab: facts, permission table with danger rows, links and re-check', async () => {
    store.data = { ...full, github: githubStatus }
    const { body } = await get('/settings')
    expect(body).toContain('<section class="t-section" id="github" data-source="app">')
    expect(body).toContain('href="#github"')
    expect(body).toContain('>2 missing<')
    expect(body).toContain('href="https://github.com/settings/apps/octohatchery-acme"')
    expect(body).toContain('href="https://github.com/settings/installations/7654321"')
    expect(body).toContain('#7654321')
    expect(body).toContain('3 repositories')
    expect(body).toContain('<code>https://hatch.example.com/webhooks/github</code>')
    expect(body).toContain('id="github-permissions"')
    expect(body).toContain('<tr data-permission="workflows" data-tone="danger">')
    expect(body).toContain('<tr data-permission="actions" data-tone="danger">')
    expect(body).toContain('<tr data-permission="contents">')
    expect(body).toContain('href="https://github.com/settings/apps/octohatchery-acme/permissions"')
    expect(body).toContain('Edit permissions on GitHub')
    expect(body).toContain('data-action="github-recheck"')
    const heads = body.slice(body.indexOf('id="github-permissions"')).match(/<th>([^<]+)<\/th>/g)!.slice(0, 5)
    expect(heads).toEqual(['<th>Permission</th>', '<th>Required</th>', '<th>Granted</th>', '<th>Why</th>', '<th>What breaks without it</th>'])
  })

  test('settings tab with several installations: one card each, accounts as checkboxes, gaps with what breaks', async () => {
    store.data = { ...full, github: githubMulti }
    const { body } = await get('/settings')
    expect(body).toContain('id="github-installations"')
    expect(body).toContain('data-installation="7654321" data-account="acme" data-allowed="true"')
    expect(body).toContain('data-installation="999" data-account="umbrella" data-allowed="false"')
    expect(body).toContain('href="https://github.com/organizations/umbrella/settings/installations/999"')
    expect(body).toContain('>organization<')
    expect(body).toContain('<code>workflows:write</code>')
    expect(body).toContain('>1 missing<')
    expect(body).toContain('2 accounts')
    expect(body).toContain('href="https://github.com/apps/octohatchery-acme/installations/new"')
    // Known values are picked: one checkbox per installation, ticked when served; no text input for the setting.
    const row = body.slice(body.indexOf('data-key="github_accounts"'))
    expect(row).toContain('<fieldset class="t-check-group gh-accounts" data-accounts aria-labelledby="gh-accounts-label">')
    expect(row).toContain('<input class="t-check-input" type="checkbox" value="acme" checked/>')
    expect(row).toContain('<input class="t-check-input" type="checkbox" value="umbrella"/>')
    expect(row).toContain('appears here after the App is installed on it')
    expect(body).not.toContain('data-setting="github_accounts"')
    // A listed account without an installation stays visible so it can be unticked; the setting is not under Other.
    store.data = { ...full, github: githubMulti, settings: { ...full.settings, github_accounts: 'acme,gone-org' } }
    const again = (await get('/settings')).body
    expect(again).toContain('value="gone-org" checked')
    expect(again).toContain('the App is not installed there')
    expect(again).not.toContain('id="s-github_accounts"')
  })

  test('settings tab with GITHUB_AUTH=none shows the .env instructions and the docs link', async () => {
    store.data = { ...full, github: { ...githubOk, ok: false, source: 'none', permissions: [], missing: [], appSlug: undefined, installationId: undefined } }
    const { body } = await get('/settings')
    expect(body).toContain('>not configured<')
    expect(body).toContain('GITHUB_AUTH=app')
    expect(body).toContain('GITHUB_AUTH=pat')
    expect(body).toContain('docs/github-app.md')
  })

  test('settings tab when GitHub could not be asked keeps the rows unknown and shows the error', async () => {
    store.data = { ...full, github: { ...githubOk, ok: false, error: 'connect ETIMEDOUT', permissions: githubOk.permissions.map((p) => ({ ...p, granted: 'unknown', ok: null })), missing: [] } }
    const { body } = await get('/settings')
    expect(body).toContain('>unchecked<')
    expect(body).toContain('connect ETIMEDOUT')
    expect(body).not.toContain('data-tone="danger">')
    expect(body).not.toContain('id="github-banner"')
  })
})

describe('hosts', () => {
  test('table with specs, leader badge, slots per host and the add-host dialog', async () => {
    const { body } = await get('/hosts')
    expect(body).toContain('id="hosts-table"')
    expect(body).toContain('<tr id="node-a" data-name="node-a"')
    const heads = [...body.matchAll(/<th[^>]*>(?:<button>)?([A-Za-z ]+?)\s*(?:<span class="t-sort-icon">)?<\//g)].map((m) => m[1]!.trim())
    expect(heads).toEqual(['Host', 'Slots', 'CPUs', 'Memory', 'OS', 'Docker', 'Docker version', 'App version', 'Last seen'])
    expect(body).toContain('<span class="t-badge host-leader" data-tone="accent" data-size="xs"')
    expect(body).toContain('<td class="t-col-num">8</td>')
    expect(body).toContain('<td class="t-col-num">32 GB</td>')
    expect(body).toContain('>ok</span>')
    expect(body).toContain('>unreachable</span>')
    expect(body).toContain('Ubuntu 24.04.1 LTS')
    expect(body).toContain('27.3.1')
    expect(body).toContain('v0.1.0-test</span>')
    expect(body).toContain('href="/templates" data-tip="Used / total slots on this host; set them under Templates">1/4</a>')
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

describe('templates', () => {
  test('/runner-types redirects to /templates for good', async () => {
    const { res } = await get('/runner-types')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/templates')
  })

  test('templates table, icon-only actions, edit dialog form, slots matrix with spawn buttons', async () => {
    const { body } = await get('/templates')
    expect(body).toContain('id="types-table"')
    expect(body).toContain('<tr id="generic" data-name="generic">')
    expect(body).toContain('What a runner is made of, and how many may run per host.')
    expect(body).toContain('New template')
    expect(body).not.toMatch(/runner types?/i)
    expect(body).toContain('data-icon="only" data-tip="Edit" data-action="type-edit"')
    expect(body).toContain('data-tone="danger" data-icon="only" data-tip="Delete" data-action="type-delete"')
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
    // the matrix is a live block refreshed on runner / slot events
    expect(body).toContain('<div id="slots-live" data-live="runner slot" class="t-table-wrap">')
    // image: a select of the default plus every image in use, "Other…" last, the real value in a hidden field
    expect(body).toContain('<form id="type-form" data-action="type-save" data-image-default="ghcr.io/rojosinalma/octohatchery-runner:edge" data-slot-hosts=')
    expect(body).toContain('<select class="t-select" id="tf-image-pick"')
    expect(body).toMatch(/<option value="ghcr.io\/rojosinalma\/octohatchery-runner:edge" selected data-missing="[^"]*">ghcr.io\/rojosinalma\/octohatchery-runner:edge[^<]*<\/option><option value="ghcr.io\/example\/runner:1" data-missing="[^"]*">ghcr.io\/example\/runner:1[^<]*<\/option><option value="">Other…<\/option>/)
    expect(body).toContain('<input class="t-input" id="tf-image-other" placeholder="registry/name:tag" aria-label="Other image" autocomplete="off" hidden/>')
    expect(body).toContain('<input type="hidden" id="tf-image" name="image" value="ghcr.io/rojosinalma/octohatchery-runner:edge"/>')
    expect(body).not.toContain('placeholder="ghcr.io/rojosinalma/octohatchery-runner:latest"')
  })

  test('Run as: a select defaulting to the image user; root templates get a badge in the list', async () => {
    let { body } = await get('/templates')
    expect(body).toContain('<select class="t-select" id="tf-run-as" name="runAs" aria-describedby="tf-run-as-hint">')
    expect(body).toContain('<option value="image" selected>Image user (runner, uid 1001)</option><option value="root">root (uid 0) — needed when jobs write root-owned files in bind mounts</option>')
    expect(body).not.toContain('data-tip="Runs as root (uid 0)"')
    store.data = { ...full, types: [{ ...full.types[0]!, runAs: 'root' }] }
    ;({ body } = await get('/templates'))
    const row = body.slice(body.indexOf('<tr id="generic"'), body.indexOf('</tr>', body.indexOf('<tr id="generic"')))
    expect(row).toContain('data-tip="Runs as root (uid 0)">root</span>')
    expect(row).toContain('&#34;runAs&#34;:&#34;root&#34;')
  })

  test('the default image comes from the runner_image_default setting', async () => {
    store.data = { ...full, settings: { ...full.settings, runner_image_default: 'registry.example/runner:2' } }
    const { body } = await get('/templates')
    expect(body).toContain('data-image-default="registry.example/runner:2"')
    expect(body).toMatch(/<option value="registry.example\/runner:2" selected data-missing="node-a,node-b">/)
  })

  test('?partial=slots returns the matrix alone', async () => {
    const { res, body } = await get('/templates?partial=slots')
    expect(res.status).toBe(200)
    expect(body.startsWith('<div id="slots-live" data-live="runner slot"')).toBe(true)
    expect(body).toContain('id="slots-matrix"')
    expect(body).not.toContain('<h1')
    expect(body).not.toContain('id="type-dlg"')
  })

  test('empty state', async () => {
    store.data = empty
    const { body } = await get('/templates')
    expect(body).toContain('No templates')
    expect(body).toContain('No hosts yet')
  })

  test('tabs link the two sub-pages; the image select marks hosts missing an image and carries the slot hosts', async () => {
    const { body } = await get('/templates')
    expect(body).toContain('<div class="t-tabs templates-tabs" data-variant="underline"><div class="t-tabs-list" role="tablist" aria-label="Templates sections">')
    expect(body).toMatch(/<a class="t-tab" role="tab" href="\/templates" id="tab-templates" aria-selected="true" tabindex="0">/)
    expect(body).toMatch(/<a class="t-tab" role="tab" href="\/templates\/images" id="tab-images" aria-selected="false" tabindex="-1">/)
    // the default is on no host, the template image is missing on node-b
    expect(body).toContain('<option value="ghcr.io/rojosinalma/octohatchery-runner:edge" selected data-missing="node-a,node-b">ghcr.io/rojosinalma/octohatchery-runner:edge · missing on node-a, node-b</option>')
    expect(body).toContain('<option value="ghcr.io/example/runner:1" data-missing="node-b">ghcr.io/example/runner:1 · missing on node-b</option>')
    expect(body).toContain('data-slot-hosts="{&#34;generic&#34;:[&#34;node-a&#34;,&#34;node-b&#34;]}"')
    expect(body).toContain('<div class="t-alert" data-tone="warning" role="status" id="tf-image-alert" hidden>')
    expect(body).toContain('id="tf-image-alert-actions"')
  })
})

describe('images', () => {
  test('matrix: one row per wanted reference, one column per host, present / missing / pulling cells with pull buttons', async () => {
    const { res, body } = await get('/templates/images')
    expect(res.status).toBe(200)
    expect(body).toContain('<title>Images · OctoHatchery</title>')
    expect(body).toContain('<h1 class="t-page-title">Templates</h1>')
    expect(body).toMatch(/href="\/templates" aria-current="page"/)
    expect(body).toMatch(/<a class="t-tab" role="tab" href="\/templates\/images" id="tab-images" aria-selected="true" tabindex="0">/)
    expect(body).toContain('<div id="images-live" data-live="image" class="t-table-wrap">')
    expect(body).toContain('id="images-table"')
    const heads = [...body.matchAll(/<th[^>]*>(?:<button>)?([A-Za-z ]+?)\s*(?:<span class="t-sort-icon">)?<\//g)].map((m) => m[1]!.trim())
    expect(heads).toEqual(['Image', 'Actions'])
    expect(body).toContain('<a href="/hosts#node-a" data-tip="Host details">node-a</a>')
    const rows = [...body.matchAll(/<tr data-reference="([^"]+)" data-missing="(\d)">/g)].map((m) => [m[1], m[2]])
    expect(rows).toEqual([
      ['docker:28-dind', '1'],
      ['ghcr.io/example/runner:1', '1'],
      ['ghcr.io/rojosinalma/octohatchery-runner:edge', '2'],
    ])
    const runner = body.slice(body.indexOf('data-reference="ghcr.io/example/runner:1"'), body.indexOf('data-reference="ghcr.io/rojosinalma'))
    // present on node-a: badge with the digest as tip, short digest · size · pulled time, a pull button
    expect(runner).toContain('<td data-host="node-a" data-state="present">')
    expect(runner).toContain('<span class="t-badge" data-tone="success" data-tip="sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef">present</span>')
    expect(runner).toMatch(/<span class="t-mono">0123456789ab<\/span> · 1\.2 GB<span data-tip="[^"]+"> · built <time class="t-time" data-relative datetime="2026-10-18T09:00:00Z">/)
    expect(runner).toContain('data-tip="Pull now on node-a" aria-label="Pull ghcr.io/example/runner:1 on node-a" data-action="image-pull" data-host="node-a" data-reference="ghcr.io/example/runner:1">')
    // missing on node-b after a failed pull: danger badges, the error as tip (escaped), button disabled because the host is offline
    expect(runner).toContain('<td data-host="node-b" data-state="missing">')
    expect(runner).toContain('>missing</span>')
    expect(runner).toContain('data-tip="manifest unknown <x>">last pull failed</span>')
    expect(runner).toMatch(/data-tip="node-b is offline"[^>]*data-host="node-b"[^>]*disabled/)
    // row action: pull on every online host
    expect(runner).toContain('data-action="image-pull-all" data-reference="ghcr.io/example/runner:1" data-hosts="node-a"')
    // queued on node-b: pulling state, busy button
    const dind = body.slice(body.indexOf('data-reference="docker:28-dind"'), body.indexOf('data-reference="ghcr.io/example/runner:1"'))
    expect(dind).toContain('<td data-host="node-b" data-state="pulling">')
    expect(dind).toContain('<span class="t-spinner" data-size="sm" aria-hidden="true"></span> queued</span>')
    expect(dind).toMatch(/data-action="image-pull" data-host="node-b" data-reference="docker:28-dind" aria-busy="true" disabled/)
    // present without digest: no mono digest, size still shown
    expect(dind).toContain('<td data-host="node-a" data-state="present">')
    expect(dind).toContain('data-tip="digest unknown"')
    expect(dind).toContain('· 381 MB')
    expect(body).not.toMatch(/\stitle="/)
  })

  test('add-image dialog offers only references missing on an online host; no free text', async () => {
    const { body } = await get('/templates/images')
    expect(body).toContain('data-dialog-open="add-image-dlg"')
    expect(body).toContain('<form id="add-image-form" data-action="image-add">')
    expect(body).not.toMatch(/add-image-dlg[\s\S]*<input class="t-input"/)
    // node-b is offline, so only the default (missing on node-a) qualifies
    expect(body).toContain('<select class="t-select" id="add-image-pick" name="reference" required><option value="ghcr.io/rojosinalma/octohatchery-runner:edge" data-hosts="node-a">ghcr.io/rojosinalma/octohatchery-runner:edge · missing on node-a</option></select>')
    expect(body).toContain('create or edit a template')
  })

  test('add-image dialog with nothing missing says so', async () => {
    store.data = { ...full, images: [...full.images!, { host: 'node-a', reference: 'ghcr.io/rojosinalma/octohatchery-runner:edge', digest: null, sizeBytes: null, pulledAt: null, seenAt: 'x' }] }
    const { body } = await get('/templates/images')
    expect(body).toContain('id="add-image-none"')
    expect(body).not.toContain('id="add-image-pick"')
  })

  test('partial and empty states', async () => {
    const { body } = await get('/templates/images?partial=1')
    expect(body.trim().startsWith('<div id="images-live" data-live="image"')).toBe(true)
    expect(body).not.toContain('<html')
    store.data = empty
    const e = (await get('/templates/images')).body
    expect(e).toContain('No hosts yet')
    store.data = { ...full, references: [] }
    const n = (await get('/templates/images')).body
    expect(n).toContain('No images yet')
    expect(n).toContain('Images appear here from templates')
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

  test('sections and sidebar in the agreed order; Other only with unknown settings', async () => {
    const order = (body: string, re: RegExp) => [...body.matchAll(re)].map((m) => m[1])
    const { body } = await get('/settings')
    const sideRe = /class="t-sidebar-item" href="#([a-z]+)"/g
    const sectionRe = /<section class="t-section" id="([a-z]+)"/g
    expect(order(body.slice(0, body.indexOf('<main')), sideRe)).toEqual(['appearance', 'github', 'buildkit', 'live', 'retention', 'scheduler', 'logging', 'other', 'about'])
    expect(order(body, sectionRe)).toEqual(['appearance', 'github', 'buildkit', 'live', 'retention', 'scheduler', 'logging', 'other', 'about'])
    expect(body).toContain('>BuildKit<')
    expect(body).toContain('#bi-box-seam')
    expect(body).toContain('data-setting="buildkit_host"')
    const { custom_flag: _drop, ...known } = full.settings
    store.data = { ...full, settings: known }
    const without = (await get('/settings')).body
    expect(order(without.slice(0, without.indexOf('<main')), sideRe)).toEqual(['appearance', 'github', 'buildkit', 'live', 'retention', 'scheduler', 'logging', 'about'])
    expect(without).not.toContain('id="other"')
    expect(without).not.toContain('No other settings are stored')
  })
})

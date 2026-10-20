import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { empty, full, githubOk, githubStatus, makeService, type FixtureSet } from './fixtures'

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

  test('the concept word stays out of the dashboard; tables say runners', async () => {
    const { body } = await get('/')
    expect(body).not.toMatch(/tentacle/)
    expect(body).toContain('Runners')
  })
})

describe('overview', () => {
  test('hosts as columns with runner seats', async () => {
    const { body } = await get('/')
    expect((body.match(/<section class="t-card"/g) ?? []).length).toBe(2)
    expect(body).toContain('href="/hosts">All hosts')
    expect((body.match(/class="host-section"/g) ?? []).length).toBe(2)
    expect((body.match(/class="runner-seat"/g) ?? []).length).toBeGreaterThan(0)
    expect((body.match(/runner-seat-free/g) ?? []).length).toBeGreaterThan(0)
  })

  test('empty state explains self-registration', async () => {
    store.data = empty
    const { res, body } = await get('/')
    expect(res.status).toBe(200)
    expect(body).toContain('No hosts yet')
    expect(body).toContain('registers itself on boot')
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
    expect(body).toMatch(/Queued[\s\S]*Status[\s\S]*Job[\s\S]*Repo[\s\S]*Queued[\s\S]*Duration[\s\S]*Run/)
  })
})

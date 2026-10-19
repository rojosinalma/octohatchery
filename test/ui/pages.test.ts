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
    // navbar with six links, the active one marked
    expect((body.match(/class="t-navbar-link"/g) ?? []).length).toBe(6)
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

  test('tagline uses the tentacle concept once; tables say runners', async () => {
    const { body } = await get('/')
    expect((body.match(/tentacle/g) ?? []).length).toBe(1)
    expect(body).toContain('Runners')
  })
})

describe('overview', () => {
  test('hosts, leader badge, slot bars, runners table with kill buttons', async () => {
    const { body } = await get('/')
    expect(body).toContain('id="hosts-table"')
    expect(body).toContain('node-a')
    expect(body).toContain('leader')
    expect(body).toContain('id="slots-table"')
    expect(body).toContain('style="--t-value: 25%"')
    expect(body).toContain('1/4')
    expect(body).toContain('id="runners-table"')
    expect(body).toContain('generic-node-a-3')
    // only live runners are listed
    expect(body).not.toContain('generic-node-a-2')
    expect(body).toContain('data-action="kill"')
    expect(body).toContain('href="/jobs?job=7"')
    // user-controlled text is escaped
    expect(body).toContain('build &lt;main&gt;')
    expect(body).not.toContain('>build <main><')
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

  test('filters narrow the list and mark the active button', async () => {
    const { body } = await get('/jobs?status=completed&repo=acme%2Fwidgets')
    expect(body).toContain('data-job-id="8"')
    expect(body).not.toContain('data-job-id="7"')
    expect(body).toMatch(/href="\/jobs\?repo=acme%2Fwidgets&status=completed" aria-pressed="true"/)
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
    const { body } = await get('/jobs?partial=1&status=in_progress')
    expect(body.trim().startsWith('<div id="jobs-live" data-live="job"')).toBe(true)
    expect(body).not.toContain('<html')
    expect(body).toContain('data-job-id="7"')
    expect(body).not.toContain('data-job-id="8"')
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
    expect(body).toContain('id="runs-on-dlg"')
    expect(body).toContain('class="t-code-copy"')
    expect(body).toMatch(/runs-on<\/span>: \[<span class="t-tok-str">self-hosted<\/span>, <span class="t-tok-str">generic<\/span>\]/)
    expect(body).toContain('data-mode="pr"')
    expect(body).toContain('data-mode="commit"')
  })

  test('empty state', async () => {
    store.data = empty
    const { body } = await get('/repos')
    expect(body).toContain('No repos adopted')
    expect(body).toContain('id="adopt-form"')
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

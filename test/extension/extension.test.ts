import { describe, expect, test } from 'bun:test'
import { alertPath, buildAlerts, GROUP_AT } from '../../extension/lib/alerts.js'
import { getJson, probe } from '../../extension/lib/api.js'
import { addEvents, cells, toolbarPlan, zeroUnseen } from '../../extension/lib/counters.js'
import { detect, KNOWN_MAX, MISS_MAX, missingRunning, outcome } from '../../extension/lib/diff.js'
import { agoText, durationText } from '../../extension/lib/format.js'
import { layout } from '../../extension/lib/icon.js'
import { pollOnce } from '../../extension/lib/poll.js'
import { checkSetting, DEFAULTS, normalizeSettings, normalizeUrl } from '../../extension/lib/settings.js'

const BASE = 'https://hatchery.example.com'
const T0 = '2026-01-01T10:00:00Z'

type J = Parameters<typeof detect>[1][number]
const job = (id: number, status: string, conclusion: string | null = null, extra: Partial<J> = {}): J => ({
  id,
  repo: 'acme/app',
  name: `job-${id}`,
  status,
  conclusion,
  runnerId: null,
  htmlUrl: `https://github.com/acme/app/actions/runs/1/job/${id}`,
  queuedAt: T0,
  startedAt: status === 'queued' ? null : T0,
  completedAt: status === 'completed' ? '2026-01-01T10:03:12Z' : null,
  ...extra,
})
const kinds = (events: { kind: string; job: { id: number } }[]) => events.map((e) => `${e.kind}:${e.job.id}`)
const baseline = (jobs: J[]) => detect(null, jobs, BASE).snapshot

describe('settings', () => {
  test('normalizeUrl keeps the origin and adds https', () => {
    expect(normalizeUrl('hatchery.example.com/jobs?x=1')).toBe(BASE)
    expect(normalizeUrl(' http://h.example.com:3000/ ')).toBe('http://h.example.com:3000')
    expect(normalizeUrl('ftp://h.example.com')).toBeNull()
    expect(normalizeUrl('https://user:pw@h.example.com')).toBeNull()
    expect(normalizeUrl('')).toBeNull()
    expect(normalizeUrl('not a url at all')).toBeNull()
  })

  test('normalizeSettings fills defaults and drops bad values', () => {
    expect(normalizeSettings(undefined)).toEqual({ ...DEFAULTS, alertRepos: [] })
    const s = normalizeSettings({ url: 'h.example.com', pollSeconds: 5, counterRunning: 'nope', badgeStyle: 'badge', alertFailed: 'yes', alertRepos: ['a/b', 'a/b', 3], extra: 1 })
    expect(s.url).toBe('https://h.example.com')
    expect(s.pollSeconds).toBe(30)
    expect(s.counterRunning).toBe('live')
    expect(s.badgeStyle).toBe('badge')
    expect(s.alertFailed).toBe(true)
    expect(s.alertRepos).toEqual(['a/b'])
    expect('extra' in s).toBe(false)
    expect(normalizeSettings({ pollSeconds: 99999 }).pollSeconds).toBe(3600)
    expect(normalizeSettings({}).themeFromHatchery).toBe(true)
    expect(normalizeSettings({ themeFromHatchery: false }).themeFromHatchery).toBe(false)
  })

  test('checkSetting accepts valid values and names the problem otherwise', () => {
    expect(checkSetting('pollSeconds', 120)).toEqual({ ok: true, value: 120 })
    expect(checkSetting('pollSeconds', 10).ok).toBe(false)
    expect(checkSetting('counterRunning', 'both')).toEqual({ ok: true, value: 'both' })
    expect(checkSetting('counterRunning', 'all').ok).toBe(false)
    expect(checkSetting('alertFailed', false)).toEqual({ ok: true, value: false })
    expect(checkSetting('alertFailed', 'false').ok).toBe(false)
    expect(checkSetting('url', 'h.example.com')).toEqual({ ok: true, value: 'https://h.example.com' })
    expect(checkSetting('nope', 1).ok).toBe(false)
  })
})

const reply = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json' }, ...init })
const fakeFetch = (fn: (url: string) => Response | Promise<Response>) => (async (input: string | URL | Request) => fn(String(input))) as typeof fetch

describe('api', () => {
  test('ok, signed out, down, missing and error', async () => {
    expect((await getJson(BASE, '/x', { fetchImpl: fakeFetch(() => reply({ ok: true, a: 1 })) })).kind).toBe('ok')
    expect((await getJson(BASE, '/x', { fetchImpl: fakeFetch(() => reply('', { status: 302, headers: { location: '/login' } })) })).kind).toBe('signed_out')
    expect((await getJson(BASE, '/x', { fetchImpl: fakeFetch(() => reply({ ok: false }, { status: 401 })) })).kind).toBe('signed_out')
    expect((await getJson(BASE, '/x', { fetchImpl: fakeFetch(() => reply('<html>login</html>')) })).kind).toBe('signed_out')
    expect((await getJson(BASE, '/x', { fetchImpl: fakeFetch(() => reply('<html>bad gateway</html>', { status: 502 })) })).kind).toBe('down')
    expect((await getJson(BASE, '/x', { fetchImpl: fakeFetch(() => Promise.reject(new TypeError('Failed to fetch'))) }))).toEqual({ kind: 'down', message: 'Failed to fetch' })
    expect((await getJson(BASE, '/x', { fetchImpl: fakeFetch(() => reply({ ok: false, message: 'job 9 not found' }, { status: 404 })) }))).toEqual({ kind: 'missing', message: 'job 9 not found' })
    expect((await getJson(BASE, '/x', { fetchImpl: fakeFetch(() => reply({ ok: false, message: 'bad' }, { status: 400 })) })).kind).toBe('error')
  })

  test('sends cookies and never follows a redirect', async () => {
    let seen: RequestInit | undefined
    const f = (async (_: string | URL | Request, init?: RequestInit) => {
      seen = init
      return reply({ ok: true })
    }) as typeof fetch
    await getJson(BASE, '/x', { fetchImpl: f })
    expect(seen?.credentials).toBe('include')
    expect(seen?.redirect).toBe('manual')
  })

  test('probe needs a version in /health and a readable jobs API', async () => {
    const good = fakeFetch((u) => (u.endsWith('/health') ? reply({ ok: true, version: '1.2.3', host: 'n1', slots: [] }) : reply({ ok: true, jobs: [] })))
    expect(await probe(BASE, { fetchImpl: good })).toEqual({ ok: true, version: '1.2.3', host: 'n1' })
    const other = fakeFetch(() => reply({ status: 'up' }))
    expect((await probe(BASE, { fetchImpl: other })).ok).toBe(false)
    const apiLocked = fakeFetch((u) => (u.endsWith('/health') ? reply({ ok: true, version: '1', slots: [] }) : reply('', { status: 302 })))
    expect(await probe(BASE, { fetchImpl: apiLocked })).toMatchObject({ ok: false, kind: 'signed_out' })
  })
})

describe('detect', () => {
  test('the first poll is a baseline without events', () => {
    const r = detect(null, [job(1, 'in_progress'), job(2, 'completed', 'failure')], BASE)
    expect(r.events).toEqual([])
    expect(r.snapshot.maxId).toBe(2)
  })

  test('a new hatchery URL starts a new baseline', () => {
    const prev = baseline([job(1, 'queued')])
    expect(detect(prev, [job(1, 'in_progress')], 'https://other.example.com').events).toEqual([])
  })

  test('queued → running → success', () => {
    let snap = baseline([job(1, 'queued')])
    let r = detect(snap, [job(1, 'claimed')], BASE)
    expect(kinds(r.events)).toEqual(['started:1'])
    snap = r.snapshot
    r = detect(snap, [job(1, 'in_progress')], BASE)
    expect(r.events).toEqual([]) // claimed → in_progress is the same running state
    r = detect(r.snapshot, [job(1, 'completed', 'success')], BASE)
    expect(kinds(r.events)).toEqual(['succeeded:1'])
    expect(detect(r.snapshot, [job(1, 'completed', 'success')], BASE).events).toEqual([])
  })

  test('every failure conclusion counts as failed', () => {
    for (const c of ['failure', 'timed_out', 'cancelled']) {
      const snap = baseline([job(1, 'in_progress')])
      expect(kinds(detect(snap, [job(1, 'completed', c)], BASE).events)).toEqual(['failed:1'])
    }
    expect(outcome('skipped')).toBeNull()
    expect(outcome('unknown')).toBeNull()
    expect(outcome(null)).toBeNull()
  })

  test('an unknown result is never guessed, and counts once it is known', () => {
    const snap = baseline([job(1, 'in_progress')])
    const r = detect(snap, [job(1, 'completed', 'unknown')], BASE)
    expect(r.events).toEqual([])
    expect(kinds(detect(r.snapshot, [job(1, 'completed', 'failure')], BASE).events)).toEqual(['failed:1'])
  })

  test('a new job that starts and ends between two polls reports both', () => {
    const snap = baseline([job(1, 'completed', 'success')])
    expect(kinds(detect(snap, [job(2, 'completed', 'failure'), job(1, 'completed', 'success')], BASE).events)).toEqual(['started:2', 'failed:2'])
    // queued at the last poll, done now
    const snap2 = baseline([job(3, 'queued')])
    expect(kinds(detect(snap2, [job(3, 'completed', 'success')], BASE).events)).toEqual(['started:3', 'succeeded:3'])
    // cancelled before it ever started: no start
    expect(kinds(detect(snap2, [job(3, 'completed', 'cancelled', { startedAt: null })], BASE).events)).toEqual(['failed:3'])
  })

  test('an old job that comes into view already completed is not news', () => {
    const snap = baseline([job(10, 'completed', 'success')])
    expect(detect(snap, [job(4, 'completed', 'failure'), job(10, 'completed', 'success')], BASE).events).toEqual([])
  })

  test('an old queued job that starts late reports started', () => {
    const snap = baseline([job(10, 'completed', 'success')])
    expect(kinds(detect(snap, [job(4, 'in_progress'), job(10, 'completed', 'success')], BASE).events)).toEqual(['started:4'])
  })

  test('a running job missing from a poll stays known for a few polls, then is dropped', () => {
    let snap = baseline([job(1, 'in_progress'), job(2, 'completed', 'success')])
    expect(missingRunning(snap, [job(2, 'completed', 'success')])).toEqual([1])
    for (let i = 0; i < MISS_MAX; i++) {
      snap = detect(snap, [job(2, 'completed', 'success')], BASE).snapshot
      expect(snap.known[1]).toBeDefined()
    }
    snap = detect(snap, [job(2, 'completed', 'success')], BASE).snapshot
    expect(snap.known[1]).toBeUndefined()
  })

  test('a job the server no longer has is dropped at once', () => {
    const snap = baseline([job(1, 'in_progress')])
    expect(detect(snap, [], BASE, [1]).snapshot.known[1]).toBeUndefined()
  })

  test('the snapshot is capped, newest kept', () => {
    const many = Array.from({ length: KNOWN_MAX + 50 }, (_, i) => job(i + 1, 'completed', 'success'))
    const snap = baseline(many)
    expect(Object.keys(snap.known).length).toBe(KNOWN_MAX)
    expect(snap.known[KNOWN_MAX + 50]).toBeDefined()
    expect(snap.known[1]).toBeUndefined()
  })
})

describe('counters', () => {
  const s = (over: Partial<typeof DEFAULTS> = {}) => normalizeSettings({ ...over })
  const unseen = { started: 2, succeeded: 3, failed: 1 }

  test('addEvents counts by kind', () => {
    expect(addEvents(zeroUnseen(), [{ kind: 'failed' }, { kind: 'failed' }, { kind: 'started' }])).toEqual({ started: 1, succeeded: 0, failed: 2 })
  })

  test('the running mode picks live, started, both or none', () => {
    expect(cells(s({ counterRunning: 'live' }), 4, unseen).map((c) => c.key)).toEqual(['running', 'succeeded', 'failed'])
    expect(cells(s({ counterRunning: 'started' }), 4, unseen).map((c) => c.key)).toEqual(['started', 'succeeded', 'failed'])
    expect(cells(s({ counterRunning: 'both' }), 4, unseen).map((c) => `${c.key}=${c.value}`)).toEqual(['running=4', 'started=2', 'succeeded=3', 'failed=1'])
    expect(cells(s({ counterRunning: 'off', counterSucceeded: false, counterFailed: false }), 4, unseen)).toEqual([])
  })

  test('badge style shows one count: failed, then succeeded, then running', () => {
    const plan = (u: typeof unseen, over = {}) => toolbarPlan(s({ badgeStyle: 'badge', ...over }), { status: 'ok', running: 2, queued: 0, unseen: u })
    expect(plan(unseen).badge.text).toBe('1')
    expect(plan({ ...unseen, failed: 0 }).badge.text).toBe('3')
    expect(plan({ started: 0, succeeded: 0, failed: 0 }).badge.text).toBe('2')
    expect(plan(unseen, { counterFailed: false }).badge.text).toBe('3')
    expect(plan({ started: 0, succeeded: 0, failed: 0 }, { counterRunning: 'off' }).badge.text).toBe('')
    expect(plan({ ...unseen, failed: 120 }).badge.text).toBe('99+')
  })

  test('icon style draws the non-zero counters and no badge', () => {
    const p = toolbarPlan(s(), { status: 'ok', running: 0, queued: 1, unseen })
    expect(p.badge.text).toBe('')
    expect(p.draw?.map((c) => c.key)).toEqual(['succeeded', 'failed'])
    expect(p.title).toContain('1 queued')
    expect(toolbarPlan(s(), { status: 'ok', running: 0, queued: 0, unseen: zeroUnseen() }).draw).toBeNull()
  })

  test('a problem shows a badge in every style', () => {
    expect(toolbarPlan(s(), { status: 'signed_out', running: 0, queued: 0, unseen }).badge.text).toBe('!')
    expect(toolbarPlan(s(), { status: 'unconfigured', running: 0, queued: 0, unseen }).badge.text).toBe('?')
    expect(toolbarPlan(s(), { status: 'down', running: 0, queued: 0, unseen, message: 'HTTP 502' }).title).toContain('HTTP 502')
  })

  test('icon layout: one fills, two split, more take fixed quarters', () => {
    expect(layout([{ key: 'failed', value: 1 }])[0]).toMatchObject({ x: 0, y: 0, w: 1, h: 1 })
    expect(layout([{ key: 'running', value: 1 }, { key: 'failed', value: 1 }]).map((b) => b.x)).toEqual([0, 0.5])
    const four = layout([{ key: 'running', value: 1 }, { key: 'succeeded', value: 1 }, { key: 'failed', value: 1 }])
    expect(four.map((b) => [b.cell.key, b.x, b.y])).toEqual([['running', 0, 0], ['succeeded', 0, 0.5], ['failed', 0.5, 0.5]])
  })
})

describe('alerts', () => {
  const s = (over = {}) => normalizeSettings(over)
  const runners = new Map([[7, { name: 'r-7', host: 'node-a', type: 'generic' }]])
  const done = job(5, 'completed', 'timed_out', { runnerId: 7 })

  test('one alert per job with where it ran and how long it took', () => {
    const [a] = buildAlerts(s(), [{ kind: 'failed', job: done }], runners, 0)
    expect(a).toEqual({ id: 'oh:job:failed:5', title: 'Failed: job-5', message: 'acme/app · node-a · generic · took 3m 12s · timed out', path: '/jobs/5' })
    expect(alertPath(a!.id)).toBe('/jobs/5')
  })

  test('the settings turn kinds off and filter repos', () => {
    expect(buildAlerts(s({ alertFailed: false }), [{ kind: 'failed', job: done }], runners, 0)).toEqual([])
    expect(buildAlerts(s({ alertRepos: ['acme/other'] }), [{ kind: 'failed', job: done }], runners, 0)).toEqual([])
    expect(buildAlerts(s({ alertRepos: ['acme/app'] }), [{ kind: 'failed', job: done }], runners, 0)).toHaveLength(1)
  })

  test(`${GROUP_AT} or more of one kind become one summary`, () => {
    const events = Array.from({ length: GROUP_AT + 1 }, (_, i) => ({ kind: 'started' as const, job: job(i + 1, 'in_progress') }))
    const [a, ...rest] = buildAlerts(s(), events, runners, 42)
    expect(rest).toEqual([])
    expect(a?.title).toBe(`${GROUP_AT + 1} jobs started`)
    expect(a?.message).toContain('and 2 more')
    expect(alertPath(a!.id)).toBe('/jobs?running=1')
  })

  test('alertPath ignores ids from elsewhere', () => {
    expect(alertPath('other')).toBeNull()
    expect(alertPath('oh:test')).toBe('/')
  })
})

describe('format', () => {
  test('durationText', () => {
    expect(durationText(45_000)).toBe('45s')
    expect(durationText(192_000)).toBe('3m 12s')
    expect(durationText(3_900_000)).toBe('1h 05m')
  })
  test('agoText', () => {
    const now = Date.parse(T0)
    expect(agoText(T0, now + 10_000)).toBe('just now')
    expect(agoText(T0, now + 5 * 60_000)).toBe('5 min ago')
    expect(agoText(T0, now + 3 * 3_600_000)).toBe('3 h ago')
    expect(agoText(null, now)).toBe('')
  })
})

describe('pollOnce', () => {
  const server = (state: { jobs: J[]; byId?: Record<number, J | null>; signedOut?: boolean }) =>
    fakeFetch((url) => {
      if (state.signedOut) return reply('', { status: 302 })
      const u = new URL(url)
      const p = u.pathname
      if (p === '/health') return reply({ ok: true, version: '9.9.9', slots: [] })
      if (p === '/api/hosts') return reply({ ok: true, hosts: [{ name: 'node-a', status: 'online', dockerOk: true, isLeader: true }] })
      if (p === '/api/slots') return reply({ ok: true, slots: [{ host: 'node-a', type: 'generic', count: 4, used: 1, free: 3 }] })
      if (p === '/api/runners') return reply({ ok: true, runners: [{ id: 7, name: 'r-7', host: 'node-a', type: 'generic' }] })
      const one = /^\/api\/jobs\/(\d+)$/.exec(p)
      if (one) {
        const j = state.byId?.[Number(one[1])]
        return j ? reply({ ok: true, job: j }) : reply({ ok: false, message: 'not found' }, { status: 404 })
      }
      let list = [...state.jobs].sort((a, b) => b.id - a.id)
      if (u.searchParams.get('running')) list = list.filter((j) => j.status === 'claimed' || j.status === 'in_progress')
      if (u.searchParams.get('status')) list = list.filter((j) => j.status === u.searchParams.get('status'))
      const total = list.length
      list = list.slice(0, Number(u.searchParams.get('limit') ?? 50))
      return reply({ ok: true, jobs: list, total })
    })

  test('builds the view and reports what changed', async () => {
    const first = await pollOnce(BASE, null, { fetchImpl: server({ jobs: [job(1, 'queued'), job(2, 'in_progress', null, { runnerId: 7 })] }) })
    if (first.status !== 'ok') throw new Error('poll failed')
    expect(first.events).toEqual([])
    expect(first.view.running.map((j) => [j.id, j.runner?.host])).toEqual([[2, 'node-a']])
    expect(first.view.queued.total).toBe(1)
    expect(first.view.hosts).toEqual([{ name: 'node-a', status: 'online', dockerOk: true, isLeader: true, used: 1, count: 4 }])
    expect(first.view.version).toBe('9.9.9')
    const second = await pollOnce(BASE, first.snapshot, { fetchImpl: server({ jobs: [job(1, 'in_progress'), job(2, 'completed', 'success', { runnerId: 7 })] }) })
    if (second.status !== 'ok') throw new Error('poll failed')
    expect(kinds(second.events)).toEqual(['started:1', 'succeeded:2'])
    expect(second.runners.get(7)?.host).toBe('node-a')
  })

  test('a long job that fell off the recent page is fetched by id', async () => {
    const first = await pollOnce(BASE, null, { fetchImpl: server({ jobs: [job(1, 'in_progress')] }) })
    if (first.status !== 'ok') throw new Error('poll failed')
    const newer = Array.from({ length: 60 }, (_, i) => job(100 + i, 'completed', 'success'))
    const second = await pollOnce(BASE, first.snapshot, { fetchImpl: server({ jobs: newer, byId: { 1: job(1, 'completed', 'failure') } }) })
    if (second.status !== 'ok') throw new Error('poll failed')
    expect(kinds(second.events).filter((k) => k.endsWith(':1'))).toEqual(['failed:1'])
  })

  test('signed out wins over every other answer', async () => {
    expect(await pollOnce(BASE, null, { fetchImpl: server({ jobs: [], signedOut: true }) })).toMatchObject({ status: 'signed_out' })
  })
})

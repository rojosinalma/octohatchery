import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { fresh, TEST_HOST } from './helpers'
import { api } from '../../src/routes/api'
import { health } from '../../src/routes/health'
import { metrics } from '../../src/routes/metrics'
import { stream, streamClients } from '../../src/routes/stream'
import { webhooks } from '../../src/routes/webhooks'
import { settings } from '../../src/lib/settings'
import { bus } from '../../src/lib/bus'
import { updateJob } from '../../src/lib/store'
import { sql } from 'drizzle-orm'

/** The core app without the mcp and ui plugins (owned by other areas). */
function coreApp() {
  return new Elysia().use(api).use(health).use(metrics).use(webhooks).use(stream)
}

async function call(app: { handle: (r: Request) => Promise<Response> }, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.handle(
    new Request(`http://local${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text)
  } catch {
    // non-JSON body (metrics)
  }
  return { status: res.status, json, text }
}

describe('health', () => {
  test('200 with snapshot when db and docker answer; 503 when docker is down', async () => {
    const w = await fresh()
    const app = coreApp()
    let r = await call(app, 'GET', '/health')
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, db: true, docker: true, host: TEST_HOST, mode: 'single', queued: 0 })
    expect(typeof r.json.version).toBe('string')
    w.docker.up = false
    r = await call(app, 'GET', '/health')
    expect(r.status).toBe(503)
    expect(r.json).toMatchObject({ ok: false, docker: false, db: true })
  })
})

describe('api', () => {
  test('runner types: list seeded, PUT upsert, validation 400, DELETE, 404', async () => {
    await fresh()
    const app = coreApp()
    let r = await call(app, 'GET', '/api/runner-types')
    expect((r.json.runnerTypes as { name: string }[]).map((t) => t.name)).toEqual(['deploy', 'generic'])
    r = await call(app, 'PUT', '/api/runner-types/gpu', { image: 'img:1', cpus: 4, memoryMb: 8192, labels: ['cuda'], secretEnv: ['HF_TOKEN'] })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, runnerType: { name: 'gpu', labels: ['cuda'], secretEnv: ['HF_TOKEN'] } })
    r = await call(app, 'PUT', '/api/runner-types/gpu', { image: 'img:1', cpus: 4 })
    expect(r.status).toBe(400)
    expect(r.json.ok).toBe(false)
    r = await call(app, 'PUT', '/api/runner-types/Bad Name', { image: 'img:1', cpus: 1, memoryMb: 512 })
    expect(r.status).toBe(400)
    r = await call(app, 'DELETE', '/api/runner-types/gpu', undefined, { 'x-actor': 'mcp:test' })
    expect(r.status).toBe(200)
    r = await call(app, 'GET', '/api/runner-types/gpu')
    expect(r.status).toBe(404)
    expect(r.json.code).toBe('not_found')
    r = await call(app, 'GET', '/api/events')
    expect((r.json.events as { actor: string; action: string }[])[0]).toMatchObject({ actor: 'mcp:test', action: 'runner_type.delete' })
  })

  test('slots, hosts, repos, jobs, runners, settings round trip', async () => {
    await fresh()
    const app = coreApp()
    expect(((await call(app, 'GET', '/api/hosts')).json.hosts as unknown[]).length).toBe(1)
    let r = await call(app, 'PUT', '/api/slots', { host: TEST_HOST, type: 'generic', count: 2 })
    expect(r.json).toMatchObject({ ok: true, slot: { host: TEST_HOST, type: 'generic', count: 2, used: 0, free: 2 } })
    r = await call(app, 'PUT', '/api/slots', { host: 'ghost', type: 'generic', count: 2 })
    expect(r.status).toBe(404)
    r = await call(app, 'POST', '/api/repos/adopt', { fullName: 'acme/app' })
    expect(r.json).toMatchObject({ ok: true, repo: { fullName: 'acme/app', adopted: true } })
    r = await call(app, 'POST', '/api/repos/runs-on', { fullName: 'acme/app', mode: 'snippet', type: 'generic' })
    expect(r.json).toMatchObject({ ok: true, snippet: 'runs-on: [self-hosted, generic]' })
    r = await call(app, 'POST', '/api/runners/spawn', { type: 'generic', host: TEST_HOST })
    expect(r.status).toBe(200)
    const runner = r.json.runner as { id: number; state: string }
    expect(runner.state).toBe('idle')
    r = await call(app, 'GET', '/api/runners?state=idle')
    expect((r.json.runners as unknown[]).length).toBe(1)
    r = await call(app, 'GET', '/api/runners?state=bogus')
    expect(r.status).toBe(400)
    r = await call(app, 'DELETE', `/api/runners/${runner.id}`)
    expect(r.json.ok).toBe(true)
    r = await call(app, 'DELETE', `/api/runners/${runner.id}`)
    expect(r.status).toBe(409)
    r = await call(app, 'GET', '/api/jobs?status=queued')
    expect(r.json.jobs).toEqual([])
    expect(r.json).toMatchObject({ total: 0, page: 1, per: 0 })
    r = await call(app, 'GET', '/api/jobs?per=10&page=2')
    expect(r.json).toMatchObject({ ok: true, total: 0, page: 2, per: 10 })
    r = await call(app, 'GET', '/api/jobs?per=11')
    expect(r.status).toBe(400)
    expect(r.json.message).toContain('expected one of 10, 20, 25, 50, 100')
    expect((await call(app, 'GET', '/api/jobs?page=0')).status).toBe(400)
    r = await call(app, 'PUT', '/api/settings/stale_runner_minutes', { value: '10' })
    expect(r.json.ok).toBe(true)
    r = await call(app, 'GET', '/api/settings')
    expect((r.json.settings as Record<string, string>).stale_runner_minutes).toBe('10')
    r = await call(app, 'POST', '/api/repos/unadopt', { fullName: 'acme/app' })
    expect(r.json.ok).toBe(true)
    r = await call(app, 'GET', '/api/nothing')
    expect(r.status).toBe(404)
  })
})

describe('metrics', () => {
  test('prometheus text with slot, job and runner series', async () => {
    await fresh()
    const app = coreApp()
    await call(app, 'PUT', '/api/slots', { host: TEST_HOST, type: 'generic', count: 3 })
    const r = await call(app, 'GET', '/metrics')
    expect(r.status).toBe(200)
    expect(r.text).toContain(`octohatchery_slots{host="${TEST_HOST}",type="generic",state="free"} 3`)
    expect(r.text).toContain('octohatchery_jobs{status="queued"} 0')
    expect(r.text).toContain('octohatchery_runner_spawns_total')
  })
})

describe('sse stream', () => {
  test('forwards bus events, enforces the client cap, cleans up on disconnect', async () => {
    await fresh()
    await settings.set('sse_max_clients', '1')
    const app = coreApp()
    const ctrl = new AbortController()
    const res = await app.handle(new Request('http://local/events/stream', { signal: ctrl.signal }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(streamClients()).toBe(1)
    const second = await app.handle(new Request('http://local/events/stream'))
    expect(second.status).toBe(503)

    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = dec.decode((await reader.read()).value) // ": connected"
    bus.emit('job', { id: 1, status: 'queued' })
    buf += dec.decode((await reader.read()).value)
    expect(buf).toContain('event: job\ndata: {"id":1,"status":"queued"}\n\n')
    ctrl.abort()
    await Bun.sleep(10)
    expect(streamClients()).toBe(0)
    expect(bus.listenerCount('job')).toBe(0)
  })
})

describe('job log api', () => {
  async function seeded() {
    const w = await fresh()
    await w.db.run(sql`insert into jobs (repo, github_job_id, run_id, name, labels, status, html_url, queued_at, completed_at, log_source, log_bytes, log_truncated)
      values ('a/b', 1, 1, 'done', '[]', 'completed', '', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', 'github', 12, true),
             ('a/b', 2, 1, 'running', '[]', 'in_progress', '', '2026-01-01T00:00:00Z', null, null, 0, false)`)
    await w.db.run(sql`insert into job_logs (job_id, seq, at, line) values (1, 1, '2026-01-01T00:00:01Z', 'one'), (1, 2, '2026-01-01T00:00:02Z', 'two'), (1, 3, '2026-01-01T00:00:03Z', 'three')`)
    return coreApp()
  }

  test('GET /api/jobs/:id and /log with paging, 404 for unknown ids, 400 for bad params', async () => {
    const app = await seeded()
    let r = await call(app, 'GET', '/api/jobs/1')
    expect(r.status).toBe(200)
    expect(r.json.job).toMatchObject({ id: 1, name: 'done', logSource: 'github', logTruncated: true, logBytes: 12 })
    expect(r.json.job).not.toHaveProperty('retries')

    r = await call(app, 'GET', '/api/jobs/1/log')
    expect(r.json).toMatchObject({ ok: true, source: 'github', truncated: true, complete: true })
    expect((r.json.lines as { line: string }[]).map((l) => l.line)).toEqual(['one', 'two', 'three'])
    r = await call(app, 'GET', '/api/jobs/1/log?after=1&limit=1')
    expect((r.json.lines as { seq: number }[]).map((l) => l.seq)).toEqual([2])

    r = await call(app, 'GET', '/api/jobs/2/log')
    expect(r.json).toMatchObject({ ok: true, lines: [], source: null, truncated: false, complete: false })

    expect((await call(app, 'GET', '/api/jobs/9/log')).status).toBe(404)
    expect((await call(app, 'GET', '/api/jobs/9')).json).toMatchObject({ ok: false, code: 'not_found' })
    expect((await call(app, 'GET', '/api/jobs/x/log')).status).toBe(400)
    expect((await call(app, 'GET', '/api/jobs/1/log?after=-1')).status).toBe(400)
  })

  test('SSE log stream: stored lines first, bus batches, end on completion; shares the client cap', async () => {
    const app = await seeded()
    await settings.set('sse_max_clients', '1')
    const ctrl = new AbortController()
    const res = await app.handle(new Request('http://local/api/jobs/2/log/stream', { signal: ctrl.signal }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(streamClients()).toBe(1)
    expect((await app.handle(new Request('http://local/events/stream'))).status).toBe(503)

    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    const read = async (until: string) => {
      let buf = ''
      while (!buf.includes(until)) buf += dec.decode((await reader.read()).value)
      return buf
    }
    await read(': connected')
    bus.emit('log', { jobId: 2, lines: [{ seq: 1, at: '2026-01-01T00:00:01Z', line: 'hello' }] })
    bus.emit('log', { jobId: 1, lines: [{ seq: 9, at: 't', line: 'other job' }] }) // filtered out
    let buf = await read('hello')
    expect(buf).toContain('event: line\ndata: {"lines":[{"seq":1,"at":"2026-01-01T00:00:01Z","line":"hello"}]}\n\n')
    expect(buf).not.toContain('other job')
    // the job becomes final: the stream reports the source and closes
    await updateJob(2, { status: 'completed', completedAt: '2026-01-01T00:02:00Z', logSource: 'runner' })
    bus.emit('log', { jobId: 2, lines: [], done: true })
    buf = await read('event: end')
    expect(buf).toContain('event: end\ndata: {"source":"runner","truncated":false,"replaced":false}\n\n')
    expect((await reader.read()).done).toBe(true)
    await Bun.sleep(10)
    expect(streamClients()).toBe(0)
    expect(bus.listenerCount('log')).toBe(0)
    ctrl.abort()
  })

  test('SSE log stream: `after` skips stored lines, a complete log ends at once, unknown job is 404', async () => {
    const app = await seeded()
    const res = await app.handle(new Request('http://local/api/jobs/1/log/stream?after=2'))
    const text = await res.text()
    expect(text).toContain('event: line\ndata: {"lines":[{"seq":3,"at":"2026-01-01T00:00:03Z","line":"three"}]}\n\n')
    expect(text).not.toContain('"two"')
    expect(text).toContain('event: end\ndata: {"source":"github","truncated":true,"replaced":false}\n\n')
    expect(streamClients()).toBe(0)
    const missing = await app.handle(new Request('http://local/api/jobs/9/log/stream'))
    expect(missing.status).toBe(404)
  })
})

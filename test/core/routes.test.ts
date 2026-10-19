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

import { describe, expect, test } from 'bun:test'
import { sign } from '@octokit/webhooks-methods'
import { Elysia } from 'elysia'
import { fresh, TEST_HOST } from './helpers'
import { service } from '../../src/lib/service'
import { getLastWebhookAt, verifySignature } from '../../src/lib/webhook'
import { webhooks } from '../../src/routes/webhooks'
import { claim } from '../../src/lib/scheduler'
import { jobByGitHubId, runnerById } from '../../src/lib/store'

const SECRET = 'test-secret'

function payload(action: string, id: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    action,
    workflow_job: { id, run_id: 77, name: 'build', labels: ['self-hosted', 'generic'], status: action, html_url: 'https://github.test/j', ...extra },
    repository: { full_name: 'acme/app' },
  })
}

async function deliver(app: { handle: (r: Request) => Promise<Response> }, event: string, body: string, secret = SECRET) {
  const res = await app.handle(
    new Request('http://local/webhooks/github', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': await sign(secret, body) },
      body,
    }),
  )
  return { status: res.status, json: (await res.json()) as { ok: boolean; message: string } }
}

describe('webhook', () => {
  test('signature verification accepts the right secret and rejects a wrong or missing one', async () => {
    await fresh()
    const body = payload('queued', 1)
    expect(await verifySignature(body, await sign(SECRET, body))).toBe(true)
    expect(await verifySignature(body, await sign('other', body))).toBe(false)
    expect(await verifySignature(body, undefined)).toBe(false)
    expect(await verifySignature(body + ' ', await sign(SECRET, body))).toBe(false)
  })

  test('route: 401 on a bad signature, nothing recorded', async () => {
    await fresh()
    const app = new Elysia().use(webhooks)
    const r = await deliver(app, 'workflow_job', payload('queued', 1), 'wrong')
    expect(r.status).toBe(401)
    expect(r.json.ok).toBe(false)
    expect(await service.listJobs()).toHaveLength(0)
  })

  test('queued → ignored for unadopted repos or without self-hosted; queued for adopted', async () => {
    await fresh()
    const app = new Elysia().use(webhooks)
    let r = await deliver(app, 'workflow_job', payload('queued', 1))
    expect(r.status).toBe(200)
    expect(r.json.message).toMatch(/not adopted/)
    await service.adoptRepo('acme/app', 'user')
    r = await deliver(app, 'workflow_job', payload('queued', 2, { labels: ['ubuntu-latest'] }))
    expect(r.json.message).toMatch(/self-hosted/)
    r = await deliver(app, 'workflow_job', payload('queued', 3))
    expect(r.json.message).toBe('job queued')
    r = await deliver(app, 'workflow_job', payload('queued', 3))
    expect(r.json.message).toBe('job already known')
    const jobs = await service.listJobs()
    // Only the job this instance may run gets a row; the rest leaves at most an audit event.
    expect(jobs.map((j) => [j.githubJobId, j.status])).toEqual([[3, 'queued']])
    const events = await service.listEvents()
    expect(events.filter((e) => e.action === 'job.ignored').map((e) => e.target)).toEqual(['acme/app#2'])
    expect(getLastWebhookAt()).not.toBeNull()
  })

  test('in_progress and completed move job and runner along', async () => {
    await fresh()
    const app = new Elysia().use(webhooks)
    await service.adoptRepo('acme/app', 'user')
    await service.setSlots({ host: TEST_HOST, type: 'generic', count: 1 }, 'user')
    await deliver(app, 'workflow_job', payload('queued', 9))
    const [runner] = await claim()
    expect(runner?.state).toBe('idle')
    await deliver(app, 'workflow_job', payload('in_progress', 9, { started_at: '2026-01-01T00:00:00Z' }))
    expect((await jobByGitHubId(9))?.status).toBe('in_progress')
    expect((await runnerById(runner!.id))?.state).toBe('busy')
    await deliver(app, 'workflow_job', payload('completed', 9, { conclusion: 'success', completed_at: '2026-01-01T00:01:00Z' }))
    const job = await jobByGitHubId(9)
    expect(job?.status).toBe('completed')
    expect(job?.conclusion).toBe('success')
    expect((await runnerById(runner!.id))?.state).toBe('exited')
  })

  test('ping answers pong, other events are skipped, malformed payloads are 400', async () => {
    await fresh()
    const app = new Elysia().use(webhooks)
    expect((await deliver(app, 'ping', '{"zen":"x"}')).json.message).toBe('pong')
    expect((await deliver(app, 'push', '{}')).status).toBe(202)
    expect((await deliver(app, 'workflow_job', '{"action":"queued"}')).status).toBe(400)
    expect((await deliver(app, 'workflow_job', 'not json')).status).toBe(400)
  })
})

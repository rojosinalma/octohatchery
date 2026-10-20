import { describe, expect, test } from 'bun:test'
import { fresh } from './helpers'
import { insertJobIfNew, insertRunner, updateJob } from '../../src/lib/store'
import { service } from '../../src/lib/service'
import { ServiceError } from '../../src/lib/types'
import { tools } from '../../src/mcp/tools'

const addJob = (repo: string, id: number, name: string, queuedAt: string, status: 'queued' | 'completed' = 'queued') =>
  insertJobIfNew({ repo, githubJobId: id, runId: 1, name, labels: ['self-hosted'], htmlUrl: '', queuedAt, status })

describe('listRepos job counts', () => {
  test('each adopted repo carries the number of job rows it has', async () => {
    const w = await fresh()
    await service.adoptRepo('acme/widgets', 'user')
    await service.adoptRepo('acme/empty', 'user')
    await addJob('acme/widgets', 1, 'build', '2026-10-20T10:00:00Z')
    await addJob('acme/widgets', 2, 'test', '2026-10-20T10:01:00Z', 'completed')
    const repos = await service.listRepos()
    expect(repos.find((r) => r.fullName === 'acme/widgets')?.jobCount).toBe(2)
    expect(repos.find((r) => r.fullName === 'acme/empty')?.jobCount).toBe(0)
    expect(w.github.calls.filter((c) => c.method === 'ensureWebhook').length).toBe(2)
  })
})

describe('ensureWebhook', () => {
  test('creates the hook through GitHub, stores its id and audits it', async () => {
    const w = await fresh()
    await service.adoptRepo('acme/widgets', 'user')
    await w.db.run((await import('drizzle-orm')).sql`update repos set webhook_id = null`)
    const out = await service.ensureWebhook('acme/widgets', 'user')
    expect(out.covered).toBe('hook')
    expect(out.repo.webhookId).toBe(1)
    expect(w.github.calls.at(-1)).toMatchObject({ method: 'ensureWebhook', args: ['acme/widgets', 'https://hatchery.example.test/webhooks/github', 'test-secret'] })
    expect((await service.listEvents()).some((e) => e.action === 'repo.webhook' && e.target === 'acme/widgets')).toBe(true)
  })
  test('unadopted repos are refused; the MCP tool exists and is not destructive', async () => {
    await fresh()
    await expect(service.ensureWebhook('acme/nope', 'user')).rejects.toBeInstanceOf(ServiceError)
    const tool = tools.find((t) => t.name === 'ensure_webhook')
    expect(tool?.destructive).toBe(false)
  })
})

describe('listJobs filters', () => {
  test('q, since, running, failed and runner narrow the list', async () => {
    await fresh()
    await service.adoptRepo('acme/widgets', 'user')
    await addJob('acme/widgets', 1, 'Build image', '2026-10-01T10:00:00Z')
    await addJob('acme/widgets', 2, 'Unit tests', '2026-10-20T10:00:00Z')
    await addJob('acme/other', 3, 'Lint', '2026-10-20T11:00:00Z', 'completed')
    const runner = await insertRunner({ name: 'generic-node-a-xyz', host: 'node-a', type: 'generic', jobId: 2, repo: 'acme/widgets', jobName: 'Unit tests' })
    await updateJob(2, { status: 'in_progress', runnerId: runner.id })
    await updateJob(3, { conclusion: 'failure' })

    const names = async (f: Parameters<typeof service.listJobs>[0]) => (await service.listJobs(f)).map((j) => j.name)
    expect(await names({ q: 'build' })).toEqual(['Build image'])
    expect(await names({ q: 'OTHER' })).toEqual(['Lint'])
    expect(await names({ q: 'node-a-xyz' })).toEqual(['Unit tests'])
    expect(await names({ q: '%' })).toEqual([])
    expect(await names({ since: '2026-10-20T00:00:00Z' })).toEqual(['Lint', 'Unit tests'])
    expect(await names({ running: true })).toEqual(['Unit tests'])
    expect(await names({ failed: true })).toEqual(['Lint'])
    expect(await names({ failed: true, repo: 'acme/widgets' })).toEqual([])
    expect(await names({ runner: 'generic-node-a-xyz' })).toEqual(['Unit tests'])
    expect(await names({ runner: 'generic-node-a-xy' })).toEqual([])
    await expect(service.listJobs({ since: 'yesterday' })).rejects.toBeInstanceOf(ServiceError)
  })
})

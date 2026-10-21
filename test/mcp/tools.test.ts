import { beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { resetService, service } from './mocks'

const { tools, findTool } = await import('../../src/mcp/tools/index')

const ctx = { actor: 'mcp:test' }

/** One valid and one invalid input per tool. Zero-argument tools reject a non-object. */
const cases: Record<string, { good: unknown; bad: unknown }> = {
  list_hosts: { good: {}, bad: null },
  list_runner_types: { good: {}, bad: null },
  upsert_runner_type: {
    good: { name: 'gpu', image: 'ghcr.io/x/y:1', cpus: 2, memoryMb: 4096 },
    bad: { name: 'Bad Name', image: 'ghcr.io/x/y:1', cpus: 2, memoryMb: 4096 },
  },
  delete_runner_type: { good: { name: 'gpu' }, bad: { name: '' } },
  list_slots: { good: {}, bad: null },
  set_slots: { good: { host: 'node-a', type: 'generic', count: 2 }, bad: { host: 'node-a', type: 'generic', count: -1 } },
  list_repos: { good: {}, bad: null },
  adopt_repo: { good: { repo: 'owner/name' }, bad: { repo: 'no-slash' } },
  unadopt_repo: { good: { repo: 'owner/name' }, bad: { repo: 'a/b/c' } },
  ensure_webhook: { good: { repo: 'owner/name' }, bad: { repo: 'no-slash' } },
  apply_runs_on: { good: { repo: 'owner/name', mode: 'snippet', type: 'generic' }, bad: { repo: 'owner/name', mode: 'push', type: 'generic' } },
  list_jobs: { good: { status: 'queued', limit: 10, q: 'build', since: '2026-10-20T00:00:00Z', running: true }, bad: { status: 'running' } },
  get_job_log: { good: { job_id: 7, tail: 50 }, bad: { job_id: 7, tail: 0 } },
  list_runners: { good: { state: 'busy' }, bad: { limit: 0 } },
  spawn: { good: { type: 'generic', host: 'node-a' }, bad: { type: 'generic' } },
  kill: { good: { runner_id: 3 }, bad: { runner_id: 'three' } },
  pull_image: { good: { host: 'node-a', reference: 'docker:28-dind' }, bad: { host: 'node-a' } },
  list_events: { good: { limit: 5 }, bad: { limit: 10_000 } },
  get_settings: { good: {}, bad: null },
  set_setting: { good: { key: 'log_level', value: 'debug' }, bad: { key: '', value: 'x' } },
  health: { good: {}, bad: null },
}

describe('tool registry', () => {
  test('registers exactly the contract tool names, once each', () => {
    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names.sort()).toEqual(Object.keys(cases).sort())
  })

  test('every tool has a description written for an agent', () => {
    for (const t of tools) expect(t.description.length).toBeGreaterThan(40)
  })

  test('destructive tools say so', () => {
    for (const name of ['kill', 'delete_runner_type', 'unadopt_repo']) {
      const t = findTool(name)!
      expect(t.destructive).toBe(true)
      expect(t.description).toContain('DESTRUCTIVE')
    }
    expect(findTool('apply_runs_on')!.description).toContain('WRITES')
  })
})

describe('each tool validates its input and resolves', () => {
  beforeEach(resetService)
  for (const [name, { good, bad }] of Object.entries(cases)) {
    test(name, async () => {
      const tool = findTool(name)!
      const schema = z.object(tool.inputSchema)
      expect(schema.safeParse(bad).success).toBe(false)
      const parsed = schema.safeParse(good)
      expect(parsed.success).toBe(true)
      await expect(tool.handler(parsed.data as never, ctx)).resolves.toBeDefined()
    })
  }
})

describe('actor and argument mapping', () => {
  beforeEach(resetService)

  test('upsert_runner_type defaults docker to none and rejects unknown values; the description explains the options', () => {
    const tool = findTool('upsert_runner_type')!
    const schema = z.object(tool.inputSchema)
    expect((schema.parse({ name: 'gpu', image: 'i', cpus: 1, memoryMb: 512 }) as { docker: string }).docker).toBe('none')
    expect((schema.parse({ name: 'gpu', image: 'i', cpus: 1, memoryMb: 512, docker: 'dind' }) as { docker: string }).docker).toBe('dind')
    expect(schema.safeParse({ name: 'gpu', image: 'i', cpus: 1, memoryMb: 512, docker: 'host' }).success).toBe(false)
    for (const word of ['"none"', '"socket"', '"dind"', 'privileged']) expect(tool.description).toContain(word)
    expect(findTool('apply_runs_on')!.description).toContain('removes the branch')
  })

  test('upsert_runner_type: runAs defaults to image, accepts root, rejects others; the description names the risk', () => {
    const tool = findTool('upsert_runner_type')!
    const schema = z.object(tool.inputSchema)
    expect((schema.parse({ name: 'gpu', image: 'i', cpus: 1, memoryMb: 512 }) as { runAs: string }).runAs).toBe('image')
    expect((schema.parse({ name: 'gpu', image: 'i', cpus: 1, memoryMb: 512, runAs: 'root' }) as { runAs: string }).runAs).toBe('root')
    expect(schema.safeParse({ name: 'gpu', image: 'i', cpus: 1, memoryMb: 512, runAs: 'admin' }).success).toBe(false)
    for (const word of ['runAs', '"image"', '"root"', 'uid 0', 'bind-mounts', 'gives root on the host']) expect(tool.description).toContain(word)
    expect(findTool('list_runner_types')!.description).toContain('runAs')
  })

  test('adopt_repo passes the repo and the actor to the facade', async () => {
    await findTool('adopt_repo')!.handler({ repo: 'owner/name' } as never, ctx)
    expect(service.adoptRepo).toHaveBeenCalledWith('owner/name', 'mcp:test')
  })

  test('apply_runs_on maps repo to fullName', async () => {
    await findTool('apply_runs_on')!.handler({ repo: 'owner/name', mode: 'pr', type: 'generic', host: 'node-a' } as never, ctx)
    expect(service.applyRunsOn).toHaveBeenCalledWith(
      { fullName: 'owner/name', mode: 'pr', type: 'generic', host: 'node-a', workflows: undefined },
      'mcp:test',
    )
  })

  test('get_job_log returns text: a header line then timestamped lines, tail defaults to 200', async () => {
    const out = await findTool('get_job_log')!.handler({ job_id: 7 } as never, ctx)
    expect(service.getJobLog).toHaveBeenCalledWith(7, { tail: 200 })
    expect(out).toBe('# job 7: source=runner truncated=false complete=true lines=2\n2026-10-20T10:00:00Z first\n2026-10-20T10:00:01Z second')
    await findTool('get_job_log')!.handler({ job_id: 7, tail: 5 } as never, ctx)
    expect(service.getJobLog).toHaveBeenLastCalledWith(7, { tail: 5 })
  })

  test('kill passes the numeric id and actor', async () => {
    await expect(findTool('kill')!.handler({ runner_id: 3 } as never, ctx)).resolves.toEqual({ killed: 3 })
    expect(service.kill).toHaveBeenCalledWith(3, 'mcp:test')
  })
})

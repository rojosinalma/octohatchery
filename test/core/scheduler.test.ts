import { describe, expect, test } from 'bun:test'
import { fresh, TEST_HOST } from './helpers'
import { matchesLabels, runnerLabels, runsOnLabels } from '../../src/lib/labels'
import { claim, reap, startPending, tick } from '../../src/lib/scheduler'
import { service } from '../../src/lib/service'
import { insertJobIfNew, jobById, runnerById } from '../../src/lib/store'
import { ServiceError } from '../../src/lib/types'
import { MAX_CLAIM_RETRIES } from '../../src/lib/spawn'

const target = { type: 'generic', typeLabels: ['gpu'], host: TEST_HOST, knownHosts: [TEST_HOST, 'node-b'] }

describe('label matching', () => {
  test('type and self-hosted required, host optional', () => {
    expect(matchesLabels(['self-hosted', 'generic'], target)).toBe(true)
    expect(matchesLabels(['self-hosted', 'generic', TEST_HOST], target)).toBe(true)
    expect(matchesLabels(['self-hosted', 'generic', 'gpu'], target)).toBe(true)
    expect(matchesLabels(['Self-Hosted', 'Generic'], target)).toBe(true)
  })
  test('rejects other hosts, unknown labels, missing type', () => {
    expect(matchesLabels(['self-hosted', 'generic', 'node-b'], target)).toBe(false)
    expect(matchesLabels(['self-hosted', 'generic', 'arm64'], target)).toBe(false)
    expect(matchesLabels(['self-hosted'], target)).toBe(false)
    expect(matchesLabels(['ubuntu-latest'], target)).toBe(false)
    expect(matchesLabels(['self-hosted', 'deploy'], target)).toBe(false)
  })
  test('runner and runs-on labels', () => {
    expect(runnerLabels('deploy', 'h1', ['x'])).toEqual(['self-hosted', 'deploy', 'h1', 'x'])
    expect(runsOnLabels('deploy')).toEqual(['self-hosted', 'deploy'])
    expect(runsOnLabels('deploy', 'h1')).toEqual(['self-hosted', 'deploy', 'h1'])
  })
})

async function queue(repo: string, id: number, labels: string[], queuedAt: string, name = `job-${id}`) {
  return insertJobIfNew({ repo, githubJobId: id, runId: 1, name, labels, htmlUrl: '', queuedAt, status: 'queued' })
}

describe('scheduler', () => {
  test('claims the oldest matching job per free slot and spawns on the fake backend', async () => {
    const w = await fresh()
    await service.adoptRepo('acme/app', 'user')
    await service.setSlots({ host: TEST_HOST, type: 'generic', count: 1 }, 'user')
    await queue('acme/app', 2, ['self-hosted', 'generic'], '2026-01-01T00:00:02Z', 'newer')
    await queue('acme/app', 1, ['self-hosted', 'generic'], '2026-01-01T00:00:01Z', 'older')
    await queue('acme/app', 3, ['self-hosted', 'deploy'], '2026-01-01T00:00:00Z', 'other-type')

    const spawned = await claim()
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.jobName).toBe('older')
    expect(spawned[0]?.state).toBe('idle')
    expect(w.docker.spawns).toHaveLength(1)
    const input = w.docker.spawns[0]!
    expect(input.env.RUNNER_TOOL_CACHE).toBe('/opt/hostedtoolcache')
    expect(input.env.BUILDKIT_HOST).toBe('tcp://octohatchery-buildkitd:1234')
    // tools are baked into the image; a shared volume there would hide them and let concurrent jobs race
    expect(input.mounts).toEqual([])
    expect(input.jitconfig).toStartWith('fake-jit-')
    expect(w.github.calls.find((c) => c.method === 'createJitConfig')?.args[0]).toMatchObject({ repo: 'acme/app', labels: ['self-hosted', 'generic', TEST_HOST] })

    const slots = await service.listSlots()
    expect(slots[0]).toMatchObject({ host: TEST_HOST, type: 'generic', count: 1, used: 1, free: 0 })
    // the second tick has no free slot: nothing more is claimed
    expect(await claim()).toHaveLength(0)
    const remaining = await service.listJobs({ status: 'queued' })
    expect(remaining.map((j) => j.name).sort()).toEqual(['newer', 'other-type'])
  })

  test('reap marks exited runners, frees the slot and the next job is claimed', async () => {
    const w = await fresh()
    await service.adoptRepo('acme/app', 'user')
    await service.setSlots({ host: TEST_HOST, type: 'generic', count: 1 }, 'user')
    await queue('acme/app', 1, ['self-hosted', 'generic'], '2026-01-01T00:00:01Z')
    await queue('acme/app', 2, ['self-hosted', 'generic'], '2026-01-01T00:00:02Z')
    const [first] = await claim()
    w.docker.exit(first!.containerId!, 0)
    await tick()
    expect((await runnerById(first!.id))?.state).toBe('exited')
    expect((await jobById(first!.jobId!))?.status).toBe('completed')
    const runners = await service.listRunners({ state: 'idle' })
    expect(runners).toHaveLength(1)
    expect(runners[0]?.jobId).not.toBe(first!.jobId)
  })

  test('missing secret env fails the spawn, requeues with a retry counter, ignores after the limit', async () => {
    await fresh()
    await service.adoptRepo('acme/app', 'user')
    await service.setSlots({ host: TEST_HOST, type: 'deploy', count: 1 }, 'user') // deploy needs DEPLOYER_TOKEN
    delete Bun.env.DEPLOYER_TOKEN
    const job = await queue('acme/app', 1, ['self-hosted', 'deploy'], '2026-01-01T00:00:01Z')
    for (let i = 1; i < MAX_CLAIM_RETRIES; i++) {
      expect(await claim()).toHaveLength(0)
      const j = await jobById(job!.id)
      expect(j?.status).toBe('queued')
      expect(j?.retries).toBe(i)
    }
    await claim()
    expect((await jobById(job!.id))?.status).toBe('ignored')
    const failed = await service.listRunners({ state: 'failed' })
    expect(failed).toHaveLength(MAX_CLAIM_RETRIES)
    const events = await service.listEvents()
    expect(events.some((e) => e.action === 'job.ignored' && String(e.detail.reason).includes('DEPLOYER_TOKEN'))).toBe(true)
  })

  test('manual spawn needs a free slot; kill removes the container', async () => {
    const w = await fresh()
    await service.adoptRepo('acme/app', 'user')
    await expect(service.spawn({ type: 'generic', host: TEST_HOST }, 'user')).rejects.toMatchObject({ code: 'conflict' })
    await service.setSlots({ host: TEST_HOST, type: 'generic', count: 1 }, 'user')
    const runner = await service.spawn({ type: 'generic', host: TEST_HOST }, 'user')
    expect(runner.state).toBe('idle')
    expect(w.docker.containers.size).toBe(1)
    await service.kill(runner.id, 'user')
    expect(w.docker.containers.size).toBe(0)
    expect(w.github.deletedRunners).toHaveLength(1)
    expect((await runnerById(runner.id))?.state).toBe('removed')
    await expect(service.kill(runner.id, 'user')).rejects.toBeInstanceOf(ServiceError)
  })

  test('pending runners for this host are started by the scheduler; orphan containers are reaped', async () => {
    const w = await fresh()
    await service.adoptRepo('acme/app', 'user')
    await service.setSlots({ host: TEST_HOST, type: 'generic', count: 2 }, 'user')
    const r = await service.spawn({ type: 'generic', host: TEST_HOST }, 'user')
    expect(await startPending()).toBe(0)
    // simulate a container whose runner row is gone (e.g. killed from another node)
    await w.db.run((await import('drizzle-orm')).sql`update runners set state = 'removed' where id = ${r.id}`)
    await reap()
    expect(w.docker.containers.size).toBe(0)
  })
})

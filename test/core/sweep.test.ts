import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { fresh, TEST_HOST } from './helpers'
import { config, setConfig } from '../../src/lib/config'
import { service } from '../../src/lib/service'
import { heartbeat, pollQueuedJobs, purgeRetention, removeStaleRunners, electLeader } from '../../src/lib/sweep'
import { claim } from '../../src/lib/scheduler'
import { recordEvent } from '../../src/lib/events'
import { runnerById } from '../../src/lib/store'

const DAY = 86_400_000

describe('sweep', () => {
  test('single mode is always leader; heartbeat marks silent hosts offline', async () => {
    const w = await fresh()
    expect(await electLeader()).toBe(true)
    await w.db.run(sql`insert into hosts (name, status, last_seen_at, is_leader, docker_ok) values ('node-b', 'online', '2000-01-01T00:00:00Z', false, true)`)
    await heartbeat()
    const hosts = await service.listHosts()
    expect(hosts.find((h) => h.name === TEST_HOST)).toMatchObject({ status: 'online', isLeader: true, dockerOk: true })
    expect(hosts.find((h) => h.name === 'node-b')?.status).toBe('offline')
  })

  test('cluster mode re-asks for the lock on every pass and steps down when it is gone', async () => {
    const w = await fresh()
    setConfig({ ...config(), mode: 'cluster' })
    const answers = [true, true, false, true]
    const real = w.db.tryLeaderLock
    w.db.tryLeaderLock = async () => answers.shift() ?? false
    try {
      expect(await electLeader()).toBe(true)
      expect(await electLeader()).toBe(true)
      expect(await electLeader()).toBe(false)
      await heartbeat()
      expect((await service.listHosts()).find((h) => h.name === TEST_HOST)?.isLeader).toBe(false)
      expect(await electLeader()).toBe(true)
      w.db.tryLeaderLock = async () => {
        throw new Error('connection closed')
      }
      expect(await electLeader()).toBe(false)
    } finally {
      w.db.tryLeaderLock = real
      setConfig({ ...config(), mode: 'single' })
    }
  })

  test('heartbeat reports the host specs; a later heartbeat without them keeps the stored ones', async () => {
    const w = await fresh()
    await heartbeat()
    const me = (await service.listHosts()).find((h) => h.name === TEST_HOST)!
    expect(me).toMatchObject({ cpus: 4, memoryMb: 8192, os: 'Fake OS 1', dockerVersion: 'fake-1.0' })
    expect(me.appVersion).toMatch(/^\d+\.\d+\.\d+/)
    w.docker.up = false
    await heartbeat()
    const again = (await service.listHosts()).find((h) => h.name === TEST_HOST)!
    expect(again.dockerOk).toBe(false)
    expect(again.dockerVersion).toBe('fake-1.0')
    expect(again.cpus).toBe(me.cpus)
  })

  test('poll fallback upserts queued jobs for adopted repos only', async () => {
    const w = await fresh()
    await service.adoptRepo('acme/app', 'user')
    const job = { githubJobId: 501, runId: 5, name: 'test', labels: ['self-hosted', 'generic'], htmlUrl: '', queuedAt: '2026-01-01T00:00:00Z' }
    w.github.queued.set('acme/app', [job, { ...job, githubJobId: 502, labels: ['ubuntu-latest'] }])
    w.github.queued.set('acme/other', [{ ...job, githubJobId: 503 }])
    expect(await pollQueuedJobs()).toBe(2)
    expect(await pollQueuedJobs()).toBe(0) // idempotent
    const jobs = await service.listJobs()
    expect(jobs.map((j) => [j.githubJobId, j.status]).sort()).toEqual([
      [501, 'queued'],
      [502, 'ignored'],
    ])
  })

  test('stale idle runners are removed and deregistered', async () => {
    const w = await fresh()
    await service.adoptRepo('acme/app', 'user')
    await service.setSlots({ host: TEST_HOST, type: 'generic', count: 1 }, 'user')
    const r = await service.spawn({ type: 'generic', host: TEST_HOST }, 'user')
    expect(await removeStaleRunners()).toBe(0) // too young
    expect(await removeStaleRunners(Date.now() + 10 * 60_000)).toBe(1)
    expect((await runnerById(r.id))?.state).toBe('removed')
    expect(w.docker.containers.size).toBe(0)
    expect(w.github.deletedRunners).toHaveLength(1)
    expect((await service.listSlots())[0]?.free).toBe(1)
  })

  test('retention purge deletes finished rows older than retention_days and keeps the rest', async () => {
    const w = await fresh()
    const old = new Date(Date.now() - 40 * DAY).toISOString()
    const recent = new Date(Date.now() - 2 * DAY).toISOString()
    await w.db.run(sql`insert into jobs (repo, github_job_id, run_id, name, labels, status, html_url, queued_at, completed_at)
      values ('a/b', 1, 1, 'old-done', '[]', 'completed', '', ${old}, ${old}),
             ('a/b', 2, 1, 'old-queued', '[]', 'queued', '', ${old}, null),
             ('a/b', 3, 1, 'recent-done', '[]', 'completed', '', ${recent}, ${recent})`)
    await w.db.run(sql`insert into runners (name, host, type, state, created_at, exited_at)
      values ('r-old', 'h', 'generic', 'exited', ${old}, ${old}), ('r-busy', 'h', 'generic', 'busy', ${old}, null)`)
    await w.db.run(sql`insert into events (actor, action, target, detail, at) values ('t', 'old', 'x', '{}', ${old})`)
    await recordEvent('t', 'new', 'x')
    await w.db.run(sql`insert into image_pulls (host_id, reference, status, requested_by, created_at, finished_at)
      values (1, 'img:old', 'done', 'user', ${old}, ${old}), (1, 'img:stuck', 'queued', 'user', ${old}, null), (1, 'img:new', 'failed', 'user', ${recent}, ${recent})`)
    const out = await purgeRetention()
    expect(out).toEqual({ jobs: 1, runners: 1, events: 1, pulls: 1 })
    expect((await w.db.all(sql`select reference from image_pulls order by id`)).map((r) => r.reference)).toEqual(['img:stuck', 'img:new'])
    expect((await service.listJobs()).map((j) => j.name).sort()).toEqual(['old-queued', 'recent-done'])
    expect((await service.listRunners()).map((r) => r.name)).toEqual(['r-busy'])
    expect((await service.listEvents()).map((e) => e.action)).toEqual(['new'])
  })

  test('retention honours the setting', async () => {
    const w = await fresh()
    await service.setSetting('retention_days', '1', 'user')
    const old = new Date(Date.now() - 2 * DAY).toISOString()
    await w.db.run(sql`insert into events (actor, action, target, detail, at) values ('t', 'old', 'x', '{}', ${old})`)
    expect((await purgeRetention()).events).toBe(1)
  })

  test('claimed jobs are not purged', async () => {
    await fresh()
    await service.adoptRepo('acme/app', 'user')
    await service.setSlots({ host: TEST_HOST, type: 'generic', count: 1 }, 'user')
    await (await import('../../src/lib/store')).insertJobIfNew({ repo: 'acme/app', githubJobId: 1, runId: 1, name: 'j', labels: ['self-hosted', 'generic'], htmlUrl: '', queuedAt: '2000-01-01T00:00:00Z', status: 'queued' })
    await claim()
    expect((await purgeRetention()).jobs).toBe(0)
  })
})

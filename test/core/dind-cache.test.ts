import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { fresh, TEST_HOST } from './helpers'
import { db } from '../../src/db'
import { toRunnerType } from '../../src/db/rows'
import { CLEAN_SCRIPT, CLEAN_WIPED, cacheVolumeIndex, cacheVolumeName, DAEMON_STORE, sweepCacheVolumes } from '../../src/lib/dind-cache'
import { reap, resetCacheSweep } from '../../src/lib/scheduler'
import { service } from '../../src/lib/service'
import { DIND_CERTS_PATH, DOCKER_CACHE_ENV, WORK_DIR } from '../../src/lib/spawn'
import type { RunnerType } from '../../src/lib/types'

const MIGRATIONS = join(import.meta.dir, '../../src/db/migrations')
const base: Omit<RunnerType, 'id' | 'createdAt' | 'updatedAt'> = { name: 'cached', description: null, labels: [], image: 'img', cpus: 1, memoryMb: 512, mounts: [], env: {}, secretEnv: [], docker: 'dind', runAs: 'image', dockerCache: 'repo' }

const storeMount = (mounts: string[] | undefined) => mounts?.find((m) => m.endsWith(`:${DAEMON_STORE}`))?.split(':')[0]

async function setup(slots = 2, env: Record<string, string> = {}) {
  const w = await fresh(env)
  await service.adoptRepo('acme/app', 'user')
  await service.upsertRunnerType(base, 'user')
  await service.setSlots({ host: TEST_HOST, type: 'cached', count: slots }, 'user')
  return w
}

describe('dind docker cache', () => {
  test('migration 0008 adds docker_cache with default none for both dialects; rows fall back to none', async () => {
    for (const dialect of ['sqlite', 'postgres']) {
      const file = readFileSync(join(MIGRATIONS, dialect, '0008_runner_type_docker_cache.sql'), 'utf8')
      expect(file).toMatch(/ALTER TABLE [`"]runner_types[`"] ADD (COLUMN )?[`"]docker_cache[`"] text DEFAULT 'none' NOT NULL/)
    }
    await fresh()
    const [row] = await db().all<Record<string, unknown>>(sql`select * from runner_types limit 1`)
    expect(row!.docker_cache).toBe('none')
    expect(toRunnerType({ ...row!, docker_cache: 'all' }).dockerCache).toBe('none')
  })

  test('only dind types may keep a cache', async () => {
    await fresh()
    await expect(service.upsertRunnerType({ ...base, name: 'sock', docker: 'socket' }, 'user')).rejects.toMatchObject({ code: 'invalid' })
    await expect(service.upsertRunnerType({ ...base, dockerCache: 'all' as never }, 'user')).rejects.toMatchObject({ code: 'invalid' })
    expect((await service.upsertRunnerType(base, 'user')).dockerCache).toBe('repo')
  })

  test('volume names: one pool per type and repository, indexed', () => {
    expect(cacheVolumeName('cached', 'Acme/App', 0)).toBe('octohatchery-cache-cached-acme.app-0')
    expect(cacheVolumeIndex('octohatchery-cache-cached-acme.app-3', 'cached', 'acme/app')).toBe(3)
    expect(cacheVolumeIndex('octohatchery-cache-cached-acme.app-x', 'cached', 'acme/app')).toBe(-1)
    expect(cacheVolumeIndex('octohatchery-cache-other-acme.app-0', 'cached', 'acme/app')).toBe(-1)
  })

  test('the daemon mounts a pool volume at its store, is cleaned before the runner, and the job is told', async () => {
    const w = await setup()
    const r = await service.spawn({ type: 'cached', host: TEST_HOST }, 'user')
    const sidecar = [...w.docker.sidecars.values()][0]!
    expect(storeMount(sidecar.input.mounts)).toBe(cacheVolumeName('cached', 'acme/app', 0))
    expect(w.docker.cacheVolumes.get(cacheVolumeName('cached', 'acme/app', 0))).toMatchObject({ host: TEST_HOST, type: 'cached', repo: 'acme/app' })
    const clean = w.docker.execs.findIndex((e) => e.cmd[0] === 'sh' && e.cmd[2] === CLEAN_SCRIPT)
    expect(clean).toBeGreaterThanOrEqual(0)
    expect(w.docker.execs[clean]!.cmd[4]).toBe(String(20 * 1024 * 1024)) // the 20 GB default, in KB
    expect(w.docker.spawns[0]!.env[DOCKER_CACHE_ENV]).toBe('kept')
    // the cache volume is not the runner's: removing the runner keeps it
    await service.kill(r.id, 'user')
    expect(w.docker.cacheVolumes.size).toBe(1)
  })

  test('the clean script removes every container, volume and network and empties a store over the cap', () => {
    expect(CLEAN_SCRIPT).toContain('docker rm -f -v $ids')
    expect(CLEAN_SCRIPT).toContain('docker volume prune -af')
    expect(CLEAN_SCRIPT).toContain('docker network prune -f')
    expect(CLEAN_SCRIPT).toContain('docker system prune -af --volumes')
    expect(CLEAN_SCRIPT).toContain(`exit ${CLEAN_WIPED}`)
  })

  test('two jobs at once get two volumes; the next job takes the lowest free one', async () => {
    const w = await setup(2)
    const [a, b] = await Promise.all([service.spawn({ type: 'cached', host: TEST_HOST }, 'user'), service.spawn({ type: 'cached', host: TEST_HOST }, 'user')])
    const used = [...w.docker.sidecars.values()].map((s) => storeMount(s.input.mounts)).sort()
    expect(used).toEqual([cacheVolumeName('cached', 'acme/app', 0), cacheVolumeName('cached', 'acme/app', 1)])
    const holderOf0 = [a!, b!].find((r) => storeMount([...w.docker.sidecars.values()].find((s) => s.labels['octohatchery.runner-id'] === String(r.id))!.input.mounts)?.endsWith('-0'))!
    await service.kill(holderOf0.id, 'user')
    await service.spawn({ type: 'cached', host: TEST_HOST }, 'user')
    const newest = [...w.docker.sidecars.values()].at(-1)!
    expect(storeMount(newest.input.mounts)).toBe(cacheVolumeName('cached', 'acme/app', 0))
  })

  test('every pool volume busy: the job gets an empty daemon', async () => {
    const w = await setup(1)
    await service.spawn({ type: 'cached', host: TEST_HOST }, 'user')
    await service.setSlots({ host: TEST_HOST, type: 'cached', count: 2 }, 'user')
    // a stray container still holds volume 1
    w.docker.cacheVolumes.set(cacheVolumeName('cached', 'acme/app', 1), { name: cacheVolumeName('cached', 'acme/app', 1), host: TEST_HOST, type: 'cached', repo: 'acme/app' })
    w.docker.listCacheVolumes = async () => [...w.docker.cacheVolumes.values()].map((v) => ({ ...v, inUse: true }))
    await service.spawn({ type: 'cached', host: TEST_HOST }, 'user')
    const second = [...w.docker.sidecars.values()][1]!
    expect(storeMount(second.input.mounts)).toBeUndefined()
    expect(w.docker.spawns[1]!.env[DOCKER_CACHE_ENV]).toBeUndefined()
  })

  test('a store over the cap is emptied and the job is told', async () => {
    const w = await setup()
    w.docker.exec = async (_id, cmd) => (cmd[0] === 'sh' ? CLEAN_WIPED : 0)
    await service.spawn({ type: 'cached', host: TEST_HOST }, 'user')
    expect(w.docker.spawns[0]!.env[DOCKER_CACHE_ENV]).toBe('emptied')
  })

  test('a failed cleanup fails the spawn and drops the store; a later failure keeps it', async () => {
    const w = await setup()
    w.docker.exec = async (_id, cmd) => (cmd[0] === 'sh' ? 1 : 0)
    await expect(service.spawn({ type: 'cached', host: TEST_HOST }, 'user')).rejects.toMatchObject({ code: 'unavailable' })
    expect(w.docker.cacheVolumes.size).toBe(0)
    expect(w.docker.sidecars.size).toBe(0)

    w.docker.exec = async () => 0
    const spawnRunner = w.docker.spawnRunner
    w.docker.spawnRunner = async () => { throw new Error('engine said no') }
    await expect(service.spawn({ type: 'cached', host: TEST_HOST }, 'user')).rejects.toMatchObject({ code: 'unavailable' })
    w.docker.spawnRunner = spawnRunner
    expect(w.docker.cacheVolumes.size).toBe(1)
  })

  test('types without the cache keep an empty daemon store', async () => {
    const w = await fresh()
    await service.adoptRepo('acme/app', 'user')
    await service.upsertRunnerType({ ...base, name: 'plain', dockerCache: 'none' }, 'user')
    await service.setSlots({ host: TEST_HOST, type: 'plain', count: 1 }, 'user')
    await service.spawn({ type: 'plain', host: TEST_HOST }, 'user')
    expect(storeMount([...w.docker.sidecars.values()][0]!.input.mounts)).toBeUndefined()
    expect(w.docker.cacheVolumes.size).toBe(0)
  })

  test('DIND_CERTS_DIR is mounted read-only into every daemon; unset = no mount', async () => {
    let w = await setup(1, { DIND_CERTS_DIR: '/etc/docker/certs.d' })
    await service.spawn({ type: 'cached', host: TEST_HOST }, 'user')
    expect([...w.docker.sidecars.values()][0]!.input.mounts).toContain(`/etc/docker/certs.d:${DIND_CERTS_PATH}:ro`)
    w = await setup(1)
    await service.spawn({ type: 'cached', host: TEST_HOST }, 'user')
    const mounts = [...w.docker.sidecars.values()][0]!.input.mounts!
    expect(mounts.some((m) => m.includes(DIND_CERTS_PATH))).toBe(false)
    expect(mounts.some((m) => m.endsWith(`:${WORK_DIR}`))).toBe(true)
  })

  test('sweep: removes volumes of other templates, above the slot count or idle; keeps busy ones and other hosts', async () => {
    const w = await setup(2)
    const r = await service.spawn({ type: 'cached', host: TEST_HOST }, 'user') // holds volume 0, a runner row for acme/app
    const add = (name: string, type = 'cached', repo = 'acme/app', host = TEST_HOST) => w.docker.cacheVolumes.set(name, { name, host, type, repo })
    add(cacheVolumeName('cached', 'acme/app', 1)) // free, in the pool, recent run: kept
    add(cacheVolumeName('cached', 'acme/app', 2)) // above the slot count
    add(cacheVolumeName('gone', 'acme/app', 0), 'gone') // template does not exist
    add(cacheVolumeName('cached', 'acme/old', 0), 'cached', 'acme/old') // no run of that repo
    add(cacheVolumeName('cached', 'acme/app', 5), 'cached', 'acme/app', 'node-z') // another host
    const removed = await sweepCacheVolumes(TEST_HOST)
    expect(removed.sort()).toEqual([cacheVolumeName('cached', 'acme/app', 2), cacheVolumeName('cached', 'acme/old', 0), cacheVolumeName('gone', 'acme/app', 0)].sort())
    expect(w.docker.cacheVolumes.has(cacheVolumeName('cached', 'acme/app', 0))).toBe(true)
    expect(w.docker.cacheVolumes.has(cacheVolumeName('cached', 'acme/app', 1))).toBe(true)

    // eight days later: the free one goes, the busy one stays
    const later = Date.now() + 8 * 86_400_000
    expect(await sweepCacheVolumes(TEST_HOST, later)).toEqual([cacheVolumeName('cached', 'acme/app', 1)])
    await service.kill(r.id, 'user')
    expect(await sweepCacheVolumes(TEST_HOST, later)).toEqual([cacheVolumeName('cached', 'acme/app', 0)])
  })

  test('the reaper runs the sweep', async () => {
    const w = await setup(1)
    w.docker.cacheVolumes.set('octohatchery-cache-gone-acme.app-0', { name: 'octohatchery-cache-gone-acme.app-0', host: TEST_HOST, type: 'gone', repo: 'acme/app' })
    resetCacheSweep()
    await reap()
    expect(w.docker.cacheVolumes.size).toBe(0)
  })
})

describe('materialise', () => {
  test('a runner already starting is not started a second time', async () => {
    const w = await setup(2)
    const { insertRunner } = await import('../../src/lib/store')
    const { materialise } = await import('../../src/lib/spawn')
    const row = await insertRunner({ name: 'twice', host: TEST_HOST, type: 'cached', jobId: null, repo: 'acme/app', jobName: null })
    const [a, b] = await Promise.all([materialise(row, 'user'), materialise(row, 'user')])
    expect([a, b].filter(Boolean).length).toBe(1)
    expect(w.docker.spawns.length).toBe(1)
    expect(w.docker.sidecars.size).toBe(1)
  })
})

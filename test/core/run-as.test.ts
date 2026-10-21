import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { fresh, TEST_HOST } from './helpers'
import { db } from '../../src/db'
import { toRunnerType } from '../../src/db/rows'
import { runnerContainerOptions } from '../../src/lib/backends/docker'
import { service } from '../../src/lib/service'
import { ROOT_USER, runnerEnv, runnerUser } from '../../src/lib/spawn'
import { api } from '../../src/routes/api'
import type { RunnerType } from '../../src/lib/types'

const base: Omit<RunnerType, 'id' | 'createdAt' | 'updatedAt'> = { name: 'x', description: null, labels: [], image: 'img', cpus: 1, memoryMb: 512, mounts: [], env: {}, secretEnv: [], docker: 'none', runAs: 'image' }
const MIGRATIONS = join(import.meta.dir, '../../src/db/migrations')

describe('runner type run_as', () => {
  test('migration 0006 exists for both dialects, adds run_as with default image, and is journalled', () => {
    for (const dialect of ['sqlite', 'postgres']) {
      const file = readFileSync(join(MIGRATIONS, dialect, '0006_runner_type_run_as.sql'), 'utf8')
      expect(file).toMatch(/ALTER TABLE [`"]runner_types[`"] ADD (COLUMN )?[`"]run_as[`"] text DEFAULT 'image' NOT NULL/)
      const journal = JSON.parse(readFileSync(join(MIGRATIONS, dialect, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] }
      expect(journal.entries.find((e) => e.idx === 6)).toMatchObject({ idx: 6, tag: '0006_runner_type_run_as' })
    }
  })

  test('rows: a row without run_as reads as image; unknown values fall back to image', async () => {
    await fresh()
    const now = new Date().toISOString()
    await db().run(sql`insert into runner_types (name, image, created_at, updated_at) values ('bare', 'img', ${now}, ${now})`)
    const [row] = await db().all(sql`select * from runner_types where name = 'bare'`)
    expect(row!.run_as).toBe('image')
    expect(toRunnerType(row!).runAs).toBe('image')
    expect(toRunnerType({ ...row!, run_as: 'admin' }).runAs).toBe('image')
    expect(toRunnerType({ ...row!, run_as: 'root' }).runAs).toBe('root')
    for (const t of await service.listRunnerTypes()) expect(t.runAs).toBe('image')
  })

  test('upsert validates, stores and audits the option', async () => {
    await fresh()
    await expect(service.upsertRunnerType({ ...base, name: 'bad', runAs: 'admin' as never }, 'user')).rejects.toMatchObject({ code: 'invalid' })
    expect((await service.upsertRunnerType({ ...base, name: 'rooty', runAs: 'root' }, 'user')).runAs).toBe('root')
    expect((await service.getRunnerType('rooty')).runAs).toBe('root')
    expect((await service.upsertRunnerType({ ...base, name: 'rooty', runAs: 'image' }, 'user')).runAs).toBe('image')
    const ev = (await service.listEvents()).find((e) => e.action === 'runner_type.upsert' && e.target === 'rooty')
    expect(ev?.detail.runAs).toBe('image')
  })

  test('spawn: root sets User 0:0, image sets nothing; the socket group stays', async () => {
    const w = await fresh()
    await service.adoptRepo('acme/app', 'user')
    await service.upsertRunnerType({ ...base, name: 'rooty', runAs: 'root', docker: 'socket' }, 'user')
    await service.upsertRunnerType({ ...base, name: 'plain' }, 'user')
    for (const type of ['rooty', 'plain']) await service.setSlots({ host: TEST_HOST, type, count: 1 }, 'user')
    await service.spawn({ type: 'rooty', host: TEST_HOST }, 'user')
    await service.spawn({ type: 'plain', host: TEST_HOST }, 'user')
    const [root, plain] = w.docker.spawns
    expect(root!.user).toBe(ROOT_USER)
    expect(root!.mounts).toContain('/var/run/docker.sock:/var/run/docker.sock')
    expect(plain!.user).toBeUndefined()

    expect(runnerUser({ runAs: 'root' })).toBe('0:0')
    expect(runnerUser({ runAs: 'image' })).toBeUndefined()
    const rootOpts = runnerContainerOptions({ ...root!, groupAdd: ['983'] })
    expect(rootOpts.User).toBe('0:0')
    expect(rootOpts.HostConfig?.GroupAdd).toEqual(['983'])
    const plainOpts = runnerContainerOptions(plain!)
    expect('User' in plainOpts).toBe(false)
  })

  test('API: PUT stores runAs, GET returns it, default image, other values rejected', async () => {
    await fresh()
    const app = new Elysia().use(api)
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.handle(new Request(`http://local${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }))
      return { status: res.status, json: (await res.json()) as Record<string, any> }
    }
    let r = await call('PUT', '/api/runner-types/rooty', { image: 'img:1', cpus: 1, memoryMb: 512, runAs: 'root' })
    expect(r.json.runnerType.runAs).toBe('root')
    r = await call('GET', '/api/runner-types/rooty')
    expect(r.json.runnerType.runAs).toBe('root')
    r = await call('PUT', '/api/runner-types/rooty', { image: 'img:1', cpus: 1, memoryMb: 512 })
    expect(r.json.runnerType.runAs).toBe('image')
    r = await call('PUT', '/api/runner-types/rooty', { image: 'img:1', cpus: 1, memoryMb: 512, runAs: 'admin' })
    expect(r.status).toBe(400)
    r = await call('GET', '/api/runner-types')
    expect(r.json.runnerTypes.every((t: RunnerType) => t.runAs === 'image')).toBe(true)
  })
  test('a root template tells the Actions runner it may run as root; the image user does not', async () => {
    await fresh()
    const t = { ...base, id: 1, createdAt: '', updatedAt: '' }
    expect((await runnerEnv({ ...t, runAs: 'root' }, {})).RUNNER_ALLOW_RUNASROOT).toBe('1')
    expect((await runnerEnv(t, {})).RUNNER_ALLOW_RUNASROOT).toBeUndefined()
  })
})

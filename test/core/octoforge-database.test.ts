import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { fresh } from './helpers'
import { closeDb, connectDb, db, type Db } from '../../src/db'
import { driverFor } from '../../src/db/drivers'
import { layoutFor, unqualify } from '../../src/db/drivers/postgres'
import { ConfigError, loadConfig } from '../../src/lib/config'
import { adoptDatabase, connectDatabase, copyPlan, databaseStatus, dropAdoptedDatabase, overridePath, resolveDatabase } from '../../src/lib/octoforge/database'
import { TEST_ENV } from './helpers'

const scratch = mkdtempSync(join(tmpdir(), 'octohatchery-adopt-'))
let n = 0
const dir = () => mkdtempSync(join(scratch, `${++n}-`))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** At least one row in every table, booleans true, a GitHub id above 32 bits. */
async function fill(d: Db = db()): Promise<void> {
  const now = new Date().toISOString()
  await d.run(sql`update hosts set is_leader = true, docker_ok = true`)
  const [host] = await d.all<{ id: unknown }>(sql`select id from hosts limit 1`)
  const [type] = await d.all<{ id: unknown }>(sql`select id from runner_types where name = 'generic'`)
  await d.run(sql`insert into slots (host_id, runner_type_id, count) values (${host!.id}, ${type!.id}, 2)`)
  await d.run(sql`insert into repos (full_name, adopted, is_private, webhook_id, adopted_at) values ('acme/app', true, true, 5000000001, ${now})`)
  for (let i = 1; i <= 3; i++) {
    await d.run(sql`insert into jobs (repo, github_job_id, run_id, name, status, queued_at, log_truncated) values ('acme/app', ${9000000000 + i}, ${7000000000 + i}, ${`build ${i}`}, 'completed', ${now}, true)`)
  }
  const [job] = await d.all<{ id: unknown }>(sql`select id from jobs order by id limit 1`)
  await d.run(sql`insert into runners (name, host, type, state, job_id, github_runner_id, created_at) values ('r-1', 'node-a', 'generic', 'exited', ${job!.id}, 6000000001, ${now})`)
  for (let i = 0; i < 700; i++) await d.run(sql`insert into job_logs (job_id, seq, at, line) values (${job!.id}, ${i}, ${now}, ${`line ${i}`})`)
  await d.run(sql`insert into events (actor, action, target, detail, at) values ('user', 'repo.adopt', 'acme/app', '{"a":1}', ${now})`)
  await d.run(sql`insert into host_images (host_id, reference, digest, size_bytes, seen_at) values (${host!.id}, 'img:1', 'sha256:x', 5000000000, ${now})`)
  await d.run(sql`insert into image_pulls (host_id, reference, status, requested_by, created_at) values (${host!.id}, 'img:1', 'done', 'user', ${now})`)
  // A gap in the ids: the target sequences must move past the highest id, not the row count.
  await d.run(sql`insert into events (id, actor, action, target, at) values (50, 'user', 'x', 'y', ${now})`)
}

async function counts(d: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of copyPlan()) out[t.name] = Number((await d.all<{ n: unknown }>(sql`select count(*) as n from ${sql.identifier(t.name)}`))[0]!.n)
  return out
}

describe('octoforge database: copy plan and migrations', () => {
  test('the plan holds every table once, parents first', () => {
    const names = copyPlan().map((t) => t.name)
    expect(names.sort()).toEqual(['events', 'host_images', 'hosts', 'image_pulls', 'job_logs', 'jobs', 'repos', 'runner_types', 'runners', 'settings', 'slots'])
    const order = copyPlan().map((t) => t.name)
    for (const [child, parent] of [['slots', 'hosts'], ['slots', 'runner_types'], ['job_logs', 'jobs'], ['host_images', 'hosts'], ['image_pulls', 'hosts']]) {
      expect(order.indexOf(child!)).toBeGreaterThan(order.indexOf(parent!))
    }
    const hosts = copyPlan().find((t) => t.name === 'hosts')!
    expect(hosts.serialId).toBe(true)
    expect(hosts.columns.find((c) => c.name === 'is_leader')!.kind).toBe('boolean')
    expect(copyPlan().find((t) => t.name === 'job_logs')!.orderBy).toEqual(['job_id', 'seq'])
    expect(copyPlan().find((t) => t.name === 'settings')!.serialId).toBe(false)
  })

  test('postgres migrations only qualify schemas in foreign keys, which the driver strips', () => {
    const folder = join(import.meta.dir, '../../src/db/migrations/postgres')
    for (const f of ['0000_init.sql', '0001_job_logs.sql', '0004_host_images.sql']) {
      const text = readFileSync(join(folder, f), 'utf8')
      expect(unqualify(text)).not.toContain('"public"')
    }
    expect(layoutFor('public')).toEqual({ schema: 'public', journal: 'drizzle', leaderKey: 'octohatchery-leader' })
    expect(layoutFor('octohatchery')).toEqual({ schema: 'octohatchery', journal: 'octohatchery', leaderKey: 'octohatchery-leader:octohatchery' })
  })
})

describe('octoforge database: sqlite', () => {
  test('sqlite → sqlite: every row copied, counts match, file 0600, override applied, drop removes it', async () => {
    const data = dir()
    const w = await fresh({ DATA_DIR: data })
    await fill()
    const before = await counts(db())
    for (const [table, rows] of Object.entries(before)) expect(rows, table).toBeGreaterThan(0)

    const url = `sqlite:${join(data, 'adopted.db')}`
    const { tables } = await adoptDatabase({ url, schema: 'octohatchery', copy: true })
    expect(tables).toEqual(before)

    const file = overridePath(data)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const content = JSON.parse(readFileSync(file, 'utf8'))
    expect(content).toMatchObject({ url, schema: 'octohatchery' })
    expect(Number.isNaN(Date.parse(content.adopted_at))).toBe(false)
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false)

    const target = await driverFor(url).open(url)
    expect(await counts(target)).toEqual(before)
    const [host] = await target.all(sql`select is_leader, docker_ok from hosts`)
    expect(host).toEqual({ is_leader: 1, docker_ok: 1 })
    const [repo] = await target.all(sql`select webhook_id from repos`)
    expect(repo!.webhook_id).toBe(5000000001)
    await target.close()

    const resolved = resolveDatabase(w.config)
    expect(resolved).toEqual({ url, schema: 'octohatchery', source: 'octoforge' })
    await connectDatabase(resolved)
    expect(databaseStatus()).toEqual({ engine: 'sqlite', source: 'octoforge' })
    expect((await counts(db())).job_logs).toBe(700)

    expect(await dropAdoptedDatabase()).toEqual({ removed: true })
    expect(existsSync(file)).toBe(false)
    expect(await dropAdoptedDatabase()).toEqual({ removed: false })
    expect(resolveDatabase(w.config)).toEqual({ url: 'sqlite::memory:', schema: undefined, source: 'env' })
  })

  test('a target with rows is refused with conflict, and no file is written', async () => {
    const data = dir()
    await fresh({ DATA_DIR: data })
    const url = `sqlite:${join(data, 'busy.db')}`
    const busy = await driverFor(url).open(url)
    await busy.run(sql`insert into settings (key, value, updated_at) values ('x', '1', 'now')`)
    await busy.close()
    await expect(adoptDatabase({ url, schema: 'octohatchery', copy: true })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('settings') })
    expect(existsSync(overridePath(data))).toBe(false)
  })

  test('copy: false migrates the target, copies nothing and writes the file', async () => {
    const data = dir()
    await fresh({ DATA_DIR: data })
    await fill()
    const url = `sqlite:${join(data, 'empty.db')}`
    const { tables } = await adoptDatabase({ url, schema: 'octohatchery', copy: false })
    expect(Object.values(tables).every((v) => v === 0)).toBe(true)
    expect(Object.keys(tables).length).toBe(copyPlan().length)
    expect(existsSync(overridePath(data))).toBe(true)
  })

  test('bad input is invalid; sqlite in cluster mode is refused', async () => {
    const data = dir()
    await fresh({ DATA_DIR: data })
    await expect(adoptDatabase({ url: 'mysql://x/y', schema: 'octohatchery', copy: true })).rejects.toMatchObject({ code: 'invalid' })
    await expect(adoptDatabase({ url: `sqlite:${join(data, 'a.db')}`, schema: 'Bad-Name', copy: true })).rejects.toMatchObject({ code: 'invalid' })
    await expect(adoptDatabase({ url: `sqlite:${join(data, 'a.db')}`, schema: 'pg_x', copy: true })).rejects.toMatchObject({ code: 'invalid' })
    await expect(adoptDatabase({ url: 'sqlite::memory:', schema: 'octohatchery', copy: true })).rejects.toMatchObject({ code: 'invalid' })
    const err = await adoptDatabase({ url: 'postgres://u:hunter2@[bad', schema: 'octohatchery', copy: true }).catch((e) => e)
    expect(err.code).toBe('invalid')
    expect(err.message).not.toContain('hunter2')
    const down = await adoptDatabase({ url: 'postgres://u:hunter2@127.0.0.1:1/x', schema: 'octohatchery', copy: true }).catch((e) => e)
    expect(down.code).toBe('unavailable')
    expect(down.message).not.toContain('hunter2')
    expect(existsSync(overridePath(data))).toBe(false)
  })

  test('a row count that differs after the copy aborts: conflict, target rolled back, no file', async () => {
    const data = dir()
    await fresh({ DATA_DIR: data })
    await fill()
    const url = `sqlite:${join(data, 'lossy.db')}`
    const lossy = await driverFor(url).open(url)
    await lossy.run(sql.raw('create trigger lose after insert on events when new.id = 50 begin delete from events where id = 50; end'))
    await lossy.close()
    await expect(adoptDatabase({ url, schema: 'octohatchery', copy: true })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('events (source 2, target 1)') })
    expect(existsSync(overridePath(data))).toBe(false)
    const after = await driverFor(url).open(url)
    expect(Object.values(await counts(after)).every((v) => v === 0)).toBe(true)
    await after.close()
  })

  test('the override file: invalid content and sqlite in cluster mode stop the start', () => {
    const data = dir()
    const cfg = loadConfig({ ...TEST_ENV, DATA_DIR: data })
    const file = overridePath(data)
    writeFileSync(file, '{"url": "postgres://u:hunter2@h/db", ')
    expect(() => resolveDatabase(cfg)).toThrow(ConfigError)
    try {
      resolveDatabase(cfg)
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2')
    }
    writeFileSync(file, JSON.stringify({ url: 'ftp://x', schema: 'a', adopted_at: 'now' }))
    expect(() => resolveDatabase(cfg)).toThrow(/url must start/)
    writeFileSync(file, JSON.stringify({ url: 'postgres://h/db', schema: 'A', adopted_at: 'now' }))
    expect(() => resolveDatabase(cfg)).toThrow(/schema must be/)
    writeFileSync(file, JSON.stringify({ url: 'sqlite:./x.db', schema: 'a', adopted_at: 'now' }))
    const cluster = loadConfig({ ...TEST_ENV, DATA_DIR: data, MODE: 'cluster', DATABASE_URL: 'postgres://h/db' })
    expect(() => resolveDatabase(cluster)).toThrow(/MODE=cluster/)
    writeFileSync(file, JSON.stringify({ url: 'postgres://h/db', schema: 'm', adopted_at: 'now' }))
    expect(resolveDatabase(cluster)).toEqual({ url: 'postgres://h/db', schema: 'm', source: 'octoforge' })
  })
})

const PG = Bun.env.TEST_POSTGRES_URL

describe.skipIf(!PG)('octoforge database: postgres', () => {
  // A throwaway database per run, so legacy detection sees nothing but what these tests create.
  const name = `oh_test_${Date.now()}`
  const role = `${name}_member`
  let admin: postgres.Sql
  let url: string
  const pgUrl = (database: string, user?: string) => {
    const u = new URL(PG!)
    u.pathname = `/${database}`
    if (user) {
      u.username = user
      u.password = 'member'
    }
    return u.toString()
  }

  beforeAll(async () => {
    admin = postgres(PG!, { max: 1, onnotice: () => {} })
    await admin.unsafe(`create database ${name}`)
    url = pgUrl(name)
  })
  afterAll(async () => {
    await closeDb()
    await admin.unsafe(`drop database if exists ${name} with (force)`)
    await admin.unsafe(`drop role if exists ${role}`)
    await admin.end()
  })

  const inDb = async <T>(fn: (c: postgres.Sql) => Promise<T>): Promise<T> => {
    const c = postgres(url, { max: 1, onnotice: () => {} })
    try {
      return await fn(c)
    } finally {
      await c.end()
    }
  }

  test('a named schema holds the tables and its own migrations journal; two schemas stay independent', async () => {
    const a = await driverFor(url).open(url, { schema: 'member_a' })
    const b = await driverFor(url).open(url, { schema: 'member_b' })
    expect(a.schema).toBe('member_a')
    await a.run(sql`insert into settings (key, value, updated_at) values ('only_a', '1', 'now')`)
    expect(await b.all(sql`select * from settings where key = 'only_a'`)).toEqual([])
    await a.close()
    await b.close()
    const rows = await inDb(
      (c) => c`select table_schema, count(*)::int as n from information_schema.tables where table_name = '__drizzle_migrations' group by table_schema order by 1`,
    )
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { table_schema: 'member_a', n: 1 },
      { table_schema: 'member_b', n: 1 },
    ])
    const journal = await inDb((c) => c`select count(*)::int as n from member_a.__drizzle_migrations`)
    expect(journal[0]!.n).toBe(7)
    const pub = await inDb((c) => c`select count(*)::int as n from information_schema.tables where table_schema = 'public'`)
    expect(pub[0]!.n).toBe(0)
    // Reopening applies nothing twice.
    const again = await driverFor(url).open(url, { schema: 'member_a' })
    expect(await again.all(sql`select key from settings where key = 'only_a'`)).toEqual([{ key: 'only_a' }])
    await again.close()
  })

  test('a role that only owns its schema (no CREATE on the database) can open it', async () => {
    await inDb(async (c) => {
      await c.unsafe(`create role ${role} login password 'member'`)
      await c.unsafe(`create schema ${role} authorization ${role}`)
    })
    const member = await driverFor(url).open(pgUrl(name, role), { schema: role })
    expect(await member.all(sql`select count(*)::int as n from runner_types`)).toEqual([{ n: 0 }])
    await member.close()
  })

  test('unset schema, tables in public: the legacy layout and lock key are kept; an explicit schema wins', async () => {
    // An empty database: the default schema.
    await admin.unsafe(`create database ${name}_fresh`)
    try {
      const empty = await driverFor(pgUrl(`${name}_fresh`)).open(pgUrl(`${name}_fresh`))
      expect(empty.schema).toBe('octohatchery')
      await empty.close()
    } finally {
      await admin.unsafe(`drop database ${name}_fresh with (force)`)
    }
    // An install from before DATABASE_SCHEMA: tables in public, journal in drizzle.
    const legacy = await driverFor(url).open(url, { schema: 'public' })
    await legacy.close()
    const detected = await driverFor(url).open(url)
    expect(detected.schema).toBe('public')
    expect(await detected.tryLeaderLock()).toBe(true)
    const held = await inDb((c) => c`select pg_try_advisory_lock(hashtext('octohatchery-leader')) as got`)
    expect(held[0]!.got).toBe(false)
    await detected.close()
    const journal = await inDb((c) => c`select count(*)::int as n from drizzle.__drizzle_migrations`)
    expect(journal[0]!.n).toBe(7)
    const own = await inDb((c) => c`select to_regclass('octohatchery.hosts') as t`)
    expect(own[0]!.t).toBeNull()

    const named = await driverFor(url).open(url, { schema: 'octohatchery' })
    expect(named.schema).toBe('octohatchery')
    expect(await named.tryLeaderLock()).toBe(true)
    const free = await inDb((c) => c`select pg_try_advisory_lock(hashtext('octohatchery-leader')) as got`)
    expect(free[0]!.got).toBe(true)
    await named.close()
    // Both layouts present: the default schema wins over the legacy one.
    const both = await driverFor(url).open(url)
    expect(both.schema).toBe('octohatchery')
    await both.close()
  })

  test('sqlite → postgres: booleans converted, big ids kept, sequences moved past the copied ids', async () => {
    const data = dir()
    await fresh({ DATA_DIR: data })
    await fill()
    const before = await counts(db())
    const { tables } = await adoptDatabase({ url, schema: 'from_sqlite', copy: true })
    expect(tables).toEqual(before)
    const target = await driverFor(url).open(url, { schema: 'from_sqlite' })
    expect(await counts(target)).toEqual(before)
    const [host] = await target.all(sql`select is_leader, docker_ok from hosts`)
    expect(host).toEqual({ is_leader: true, docker_ok: true })
    const [job] = await target.all<{ github_job_id: unknown }>(sql`select github_job_id from jobs order by id limit 1`)
    expect(Number(job!.github_job_id)).toBe(9000000001)
    const [ev] = await target.all<{ id: number }>(sql`insert into events (actor, action, target, at) values ('a', 'b', 'c', 'now') returning id`)
    expect(ev!.id).toBe(51)
    await target.close()
    expect(JSON.parse(readFileSync(overridePath(data), 'utf8'))).toMatchObject({ url, schema: 'from_sqlite' })
  })

  test('postgres → postgres in one database, then postgres → sqlite; status reports the schema', async () => {
    const data = dir()
    await fresh({ DATA_DIR: data, DATABASE_URL: url, DATABASE_SCHEMA: 'src_pg' })
    expect(databaseStatus()).toEqual({ engine: 'postgres', schema: 'src_pg', source: 'env' })
    await fill()
    const before = await counts(db())
    expect((await adoptDatabase({ url, schema: 'dst_pg', copy: true })).tables).toEqual(before)
    const target = await driverFor(url).open(url, { schema: 'dst_pg' })
    const [ev] = await target.all<{ id: number }>(sql`insert into events (actor, action, target, at) values ('a', 'b', 'c', 'now') returning id`)
    expect(ev!.id).toBe(51)
    const [slot] = await target.all<{ id: number }>(sql`insert into slots (host_id, runner_type_id, count) select h.id, t.id, 1 from hosts h, runner_types t where t.name = 'deploy' returning id`)
    expect(slot!.id).toBeGreaterThan(1)
    await target.close()

    const sqliteUrl = `sqlite:${join(data, 'back.db')}`
    expect((await adoptDatabase({ url: sqliteUrl, schema: 'octohatchery', copy: true })).tables).toEqual(before)
    const back = await driverFor(sqliteUrl).open(sqliteUrl)
    expect(await back.all(sql`select is_leader from hosts`)).toEqual([{ is_leader: 1 }])
    await back.close()

    // copy: false on a second instance: the target already holds the rows and is only migrated.
    expect((await adoptDatabase({ url, schema: 'dst_pg', copy: false })).tables.events).toBe(before.events! + 1)
    await connectDb(url, { schema: 'dst_pg' })
    expect(db().schema).toBe('dst_pg')
  })
})

// Octoforge member contract v1, section 3 (database): which database to open at start, and moving into another one.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableColumns, getTableName, sql } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import { connectDb, db, dbConnected, dbUrl, type Db } from '../../db'
import { driverFor } from '../../db/drivers'
import { bool, num } from '../../db/rows'
import * as sqliteSchema from '../../db/schema'
import * as pgSchema from '../../db/schema.pg'
import { config, ConfigError, DATABASE_URL_PATTERN, SCHEMA_NAME_PATTERN, type Config } from '../config'
import { log } from '../log'
import { ServiceError } from '../types'

export type DatabaseSource = 'env' | 'octoforge'
export type DatabaseStatus = { engine: 'sqlite' | 'postgres'; schema?: string; source: DatabaseSource }
export type AdoptInput = { url: string; schema: string; copy: boolean }
export type AdoptResult = { tables: Record<string, number> }
/** The database to open at start and where that choice came from. */
export type ResolvedDatabase = { url: string; schema: string | undefined; source: DatabaseSource }
/** Content of `DATA_DIR/octoforge-database.json`. */
type OverrideFile = { url: string; schema: string; adopted_at: string }

export const OVERRIDE_FILE = 'octoforge-database.json'
/** Bound parameters per insert; well under the limits of both engines (SQLite 32766, Postgres 65535). */
const PARAMS_PER_BATCH = 2000

const logger = log('db')
/** What `connectDatabase` opened last; a handle opened another way (tests, a reconnect to another URL) counts as env. */
let opened: { url: string; source: DatabaseSource } | undefined

export function overridePath(dataDir: string): string {
  return join(dataDir, OVERRIDE_FILE)
}

/**
 * The database to open: `DATA_DIR/octoforge-database.json` when present (written by an adoption), else
 * DATABASE_URL / DATABASE_SCHEMA. A file that is there but unusable stops the start with a reason.
 */
export function resolveDatabase(cfg: Config): ResolvedDatabase {
  const file = overridePath(cfg.dataDir)
  if (!existsSync(file)) return { url: cfg.databaseUrl, schema: cfg.databaseSchema, source: 'env' }
  let parsed: Partial<OverrideFile>
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<OverrideFile>
  } catch {
    // The parser's message can quote the content, which holds a password: never echo it.
    throw new ConfigError(`${file} is not valid JSON; fix it or delete it to use DATABASE_URL again`)
  }
  if (typeof parsed !== 'object' || parsed === null) throw new ConfigError(`${file} must hold a JSON object`)
  if (typeof parsed.url !== 'string' || !DATABASE_URL_PATTERN.test(parsed.url)) {
    throw new ConfigError(`${file}: url must start with sqlite: or postgres://`)
  }
  if (typeof parsed.schema !== 'string' || !SCHEMA_NAME_PATTERN.test(parsed.schema)) {
    throw new ConfigError(`${file}: schema must be a lowercase identifier (a-z, 0-9, _)`)
  }
  if (typeof parsed.adopted_at !== 'string') throw new ConfigError(`${file}: adopted_at is missing`)
  if (cfg.mode === 'cluster' && parsed.url.startsWith('sqlite:')) {
    throw new ConfigError(`${file} names a SQLite database, but MODE=cluster needs a shared postgres:// database`)
  }
  return { url: parsed.url, schema: parsed.schema, source: 'octoforge' }
}

/** Opens the resolved database as the process-wide handle and remembers where it came from. */
export async function connectDatabase(target: ResolvedDatabase): Promise<Db> {
  const handle = await connectDb(target.url, { schema: target.schema })
  opened = { url: target.url, source: target.source }
  return handle
}

/** Engine, schema and where the running database came from; never the URL. */
export function databaseStatus(): DatabaseStatus {
  if (!dbConnected()) throw new ServiceError('database not connected', 'unavailable')
  const current = db()
  const openedFrom = opened && opened.url === dbUrl() ? opened.source : 'env'
  return current.dialect === 'postgres' ? { engine: 'postgres', schema: current.schema, source: openedFrom } : { engine: 'sqlite', source: openedFrom }
}

type CopyColumn = { name: string; kind: 'boolean' | 'number' | 'text' }
type CopyTable = { name: string; columns: CopyColumn[]; orderBy: string[]; serialId: boolean }

let plan: CopyTable[] | undefined

/**
 * Every table of the schema, parents before children (foreign keys), with what the copy needs per column. Read
 * from the Drizzle schema objects, so a new table or column is copied without touching this file.
 */
export function copyPlan(): CopyTable[] {
  if (plan) return plan
  const pgByName = new Map<string, PgTable>(Object.values(pgSchema).map((t) => [getTableName(t), t]))
  const all = (Object.values(sqliteSchema) as SQLiteTable[]).map((t) => {
    const cfg = getTableConfig(t)
    const columns = Object.values(getTableColumns(t)).map((c) => ({
      name: c.name,
      kind: c.dataType === 'boolean' ? ('boolean' as const) : c.dataType === 'number' ? ('number' as const) : ('text' as const),
    }))
    const primary = cfg.primaryKeys[0]?.columns.map((c) => c.name) ?? Object.values(getTableColumns(t)).filter((c) => c.primary).map((c) => c.name)
    const pgTable = pgByName.get(cfg.name)
    const pgId = pgTable ? Object.values(getTableColumns(pgTable)).find((c) => c.name === 'id') : undefined
    return {
      name: cfg.name,
      columns,
      orderBy: primary.length ? primary : columns.map((c) => c.name),
      serialId: pgId?.columnType === 'PgSerial',
      parents: cfg.foreignKeys.map((fk) => getTableName(fk.reference().foreignTable)).filter((p) => p !== cfg.name),
    }
  })
  const ordered: CopyTable[] = []
  const done = new Set<string>()
  let pending = all.sort((a, b) => a.name.localeCompare(b.name))
  while (pending.length) {
    const ready = pending.filter((t) => t.parents.every((p) => done.has(p)))
    if (!ready.length) throw new Error(`foreign keys form a cycle between ${pending.map((t) => t.name).join(', ')}`)
    for (const { parents: _parents, ...t } of ready) {
      ordered.push(t)
      done.add(t.name)
    }
    pending = pending.filter((t) => !done.has(t.name))
  }
  plan = ordered
  return plan
}

/** One value from either engine into the form the target engine stores (SQLite booleans are 0/1, Postgres int8 arrives as text). */
function convert(value: unknown, kind: CopyColumn['kind'], to: Db['dialect']): unknown {
  if (value === null || value === undefined) return null
  if (kind === 'boolean') return to === 'postgres' ? bool(value) : bool(value) ? 1 : 0
  if (kind === 'number') return num(value)
  return typeof value === 'string' ? value : String(value)
}

async function countRows(conn: Db, table: string): Promise<number> {
  const [row] = await conn.all<{ n: unknown }>(sql`select count(*) as n from ${sql.identifier(table)}`)
  return num(row?.n ?? 0)
}

/** Copies one table page by page in primary-key order; returns the number of rows written. */
async function copyTable(from: Db, to: Db, t: CopyTable): Promise<number> {
  const columns = sql.join(t.columns.map((c) => sql.identifier(c.name)), sql`, `)
  const order = sql.join(t.orderBy.map((c) => sql.identifier(c)), sql`, `)
  const pageSize = Math.max(1, Math.floor(PARAMS_PER_BATCH / t.columns.length))
  let copied = 0
  for (;;) {
    const rows = await from.all(sql`select ${columns} from ${sql.identifier(t.name)} order by ${order} limit ${pageSize} offset ${copied}`)
    if (!rows.length) break
    const values = rows.map((r) => sql`(${sql.join(t.columns.map((c) => sql`${convert(r[c.name], c.kind, to.dialect)}`), sql`, `)})`)
    await to.run(sql`insert into ${sql.identifier(t.name)} (${columns}) values ${sql.join(values, sql`, `)}`)
    copied += rows.length
    if (rows.length < pageSize) break
  }
  return copied
}

/** Error text without the URL or its password, for answers and logs. */
function redact(message: string, url: string): string {
  let out = message.replaceAll(url, '<database url>')
  try {
    const password = decodeURIComponent(new URL(url).password)
    if (password) out = out.replaceAll(password, '***')
  } catch {
    // not a URL with a password
  }
  return out
}

function validate(input: AdoptInput): void {
  const { url, schema } = input
  if (typeof url !== 'string' || !DATABASE_URL_PATTERN.test(url)) throw new ServiceError('url must start with sqlite: or postgres://', 'invalid')
  if (typeof schema !== 'string' || !SCHEMA_NAME_PATTERN.test(schema)) {
    throw new ServiceError('schema must be a lowercase identifier (a-z, 0-9, _), at most 63 characters, not starting with pg_', 'invalid')
  }
  if (url.startsWith('sqlite:')) {
    if (config().mode === 'cluster') throw new ServiceError('MODE=cluster needs a shared postgres:// database; a SQLite file cannot be shared', 'invalid')
    if (/^sqlite:(\/\/)?:memory:$/.test(url)) throw new ServiceError('an in-memory SQLite database cannot be adopted', 'invalid')
  } else {
    try {
      new URL(url)
    } catch {
      // The runtime's message quotes the URL; say what is wrong without it.
      throw new ServiceError('url is not a valid postgres:// URL', 'invalid')
    }
  }
}

/** Writes the override file atomically (temp file + rename), mode 0600. */
function writeOverride(content: OverrideFile): void {
  const dir = config().dataDir
  mkdirSync(dir, { recursive: true })
  const file = overridePath(dir)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

/**
 * Moves this member into the database at `url`: migrates it (schema `schema` on Postgres), copies every row
 * when `copy` and checks the row counts per table, then writes DATA_DIR/octoforge-database.json so the next start
 * opens it. Any failure leaves the current database in use and the file unwritten. Never logs the URL.
 */
export async function adoptDatabase(input: AdoptInput): Promise<AdoptResult> {
  validate(input)
  const { url, schema, copy } = input
  const source = db()
  let target: Db
  try {
    target = await driverFor(url).open(url, { schema })
  } catch (err) {
    throw new ServiceError(`could not open the target database: ${redact(err instanceof Error ? err.message : String(err), url)}`, 'unavailable')
  }
  const tables: Record<string, number> = {}
  try {
    const engine = target.dialect === 'postgres' ? `postgres schema ${schema}` : 'sqlite'
    if (!copy) {
      for (const t of copyPlan()) tables[t.name] = await countRows(target, t.name)
      logger.info(`adopt: target ${engine} migrated, nothing copied (copy: false)`)
    } else {
      const filled = []
      for (const t of copyPlan()) if ((await countRows(target, t.name)) > 0) filled.push(t.name)
      if (filled.length) throw new ServiceError(`target database is not empty: ${filled.join(', ')} already hold rows`, 'conflict')
      // One snapshot of the source (Postgres: REPEATABLE READ; SQLite: the write lock) and one target transaction:
      // either every table arrives with the same count, or nothing does.
      await source.transaction(async (from) => {
        if (from.dialect === 'postgres') await from.run(sql`set transaction isolation level repeatable read`)
        await target.transaction(async (to) => {
          const mismatched: string[] = []
          for (const t of copyPlan()) {
            const expected = await countRows(from, t.name)
            await copyTable(from, to, t)
            const got = await countRows(to, t.name)
            tables[t.name] = got
            logger.info(`adopt: ${t.name} ${got}`)
            if (got !== expected) mismatched.push(`${t.name} (source ${expected}, target ${got})`)
          }
          if (mismatched.length) throw new ServiceError(`row counts differ after the copy: ${mismatched.join(', ')}; nothing was adopted`, 'conflict')
          if (to.dialect === 'postgres') {
            // Ids were copied as they are; move each sequence past them so the next insert gets a fresh id.
            for (const t of copyPlan().filter((p) => p.serialId)) {
              await to.run(sql`select setval(pg_get_serial_sequence(${t.name}, 'id'), coalesce((select max(id) from ${sql.identifier(t.name)}), 0) + 1, false)`)
            }
          }
        })
      })
      const rows = Object.values(tables).reduce((a, b) => a + b, 0)
      logger.info(`adopt: copied ${rows} rows in ${Object.keys(tables).length} tables to ${engine}`)
    }
    writeOverride({ url, schema, adopted_at: new Date().toISOString() })
    logger.info(`adopt: wrote ${overridePath(config().dataDir)}; restart to use the adopted database`)
    return { tables }
  } catch (err) {
    if (err instanceof ServiceError) {
      logger.warn(`adopt failed: ${err.message}`)
      throw err
    }
    const reason = redact(err instanceof Error ? err.message : String(err), url)
    logger.error(`adopt failed: ${reason}`)
    throw new ServiceError(`adoption failed, the current database stays in use: ${reason}`, 'unavailable')
  } finally {
    await target.close().catch(() => {})
  }
}

/** Removes DATA_DIR/octoforge-database.json; the next start uses DATABASE_URL again. */
export async function dropAdoptedDatabase(): Promise<{ removed: boolean }> {
  const file = overridePath(config().dataDir)
  if (!existsSync(file)) return { removed: false }
  unlinkSync(file)
  logger.info(`removed ${file}; the next start opens DATABASE_URL`)
  return { removed: true }
}

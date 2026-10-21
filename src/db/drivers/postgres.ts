import postgres from 'postgres'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { sql, type SQL } from 'drizzle-orm'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import type { Db, Driver, Row } from '../driver'
import { log } from '../../lib/log'

const MIGRATIONS = new URL('../migrations/postgres', import.meta.url).pathname
/** Schema the tables live in when DATABASE_SCHEMA is unset (and no legacy layout is found). */
export const DEFAULT_SCHEMA = 'octohatchery'
/** Lock key of the legacy layout (tables in `public`); a named schema gets `<key>:<schema>`. */
const LEGACY_LEADER_KEY = 'octohatchery-leader'
/** Journal schema of the legacy layout, Drizzle's own default. */
const LEGACY_JOURNAL_SCHEMA = 'drizzle'
const JOURNAL_TABLE = '__drizzle_migrations'

const logger = log('db')
let legacyWarned = false

/**
 * Where the tables and the migrations journal live. `public` is the legacy layout of every install before
 * DATABASE_SCHEMA existed: journal in schema `drizzle`, the unsuffixed lock key, so an upgraded node and an older
 * one still elect one leader between them. Any other schema keeps its journal inside itself.
 */
export function layoutFor(schema: string): { schema: string; journal: string; leaderKey: string } {
  return schema === 'public'
    ? { schema, journal: LEGACY_JOURNAL_SCHEMA, leaderKey: LEGACY_LEADER_KEY }
    : { schema, journal: schema, leaderKey: `${LEGACY_LEADER_KEY}:${schema}` }
}

/**
 * No schema asked for: the default, unless the database already has the tables in `public` and none in the
 * default schema. That is an install from before DATABASE_SCHEMA, kept where it is (warned once per process).
 */
async function detectSchema(client: postgres.Sql): Promise<string> {
  const [row] = await client`
    select to_regclass('public.hosts') is not null as legacy,
           to_regclass(${`${DEFAULT_SCHEMA}.hosts`}) is not null as current`
  if (row?.legacy === true && row?.current !== true) {
    if (!legacyWarned) {
      logger.warn('tables found in schema public; set DATABASE_SCHEMA=public to silence this, or adopt a database to move')
      legacyWarned = true
    }
    return 'public'
  }
  return DEFAULT_SCHEMA
}

function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** Drizzle-kit writes foreign keys as `"public"."table"`; unqualified, they resolve through search_path like everything else. */
export function unqualify(statement: string): string {
  return statement.replaceAll('REFERENCES "public".', 'REFERENCES ')
}

/**
 * Drizzle's migrator, with two differences: the journal schema is ours, and a schema that exists is never
 * created again (`create schema if not exists` needs CREATE on the database even when the schema is there, which
 * a role that only owns its schema lacks). Same journal rows as Drizzle's, so either can follow the other.
 */
async function migrate(client: postgres.Sql, layout: { schema: string; journal: string }): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS })
  for (const name of new Set([layout.schema, layout.journal])) {
    const [found] = await client`select 1 as ok from pg_namespace where nspname = ${name}`
    if (!found) await client.unsafe(`create schema ${ident(name)}`)
  }
  const journal = `${ident(layout.journal)}.${ident(JOURNAL_TABLE)}`
  await client.unsafe(`create table if not exists ${journal} (id serial primary key, hash text not null, created_at bigint)`)
  const [last] = await client.unsafe(`select created_at from ${journal} order by created_at desc limit 1`)
  const after = last ? Number(last.created_at) : -1
  await client.begin(async (tx) => {
    for (const m of migrations) {
      if (m.folderMillis <= after) continue
      for (const statement of m.sql) await tx.unsafe(unqualify(statement))
      await tx.unsafe(`insert into ${journal} (hash, created_at) values ($1, $2)`, [m.hash, m.folderMillis])
    }
  })
}

type Executor = PostgresJsDatabase | PgTransaction<never, never, never>

function wrap(exec: Pick<Executor, 'execute'>, rest: Omit<Db, 'all' | 'run'>): Db {
  return {
    ...rest,
    async all<T extends Row>(query: SQL) {
      const res = await exec.execute(query)
      return Array.from(res) as T[]
    },
    async run(query: SQL) {
      await exec.execute(query)
    },
  }
}

export const postgresDriver: Driver = {
  schemes: ['postgres', 'postgresql'],
  async open(url, options = {}) {
    const parsed = new URL(url)
    const ssl = parsed.searchParams.get('sslmode') === 'require' ? ('require' as const) : undefined
    const base = { ssl, idle_timeout: 30, connect_timeout: 10, onnotice: () => {} }
    let schema = options.schema
    if (schema === undefined) {
      const probe = postgres(url, { ...base, max: 1 })
      try {
        schema = await detectSchema(probe)
      } finally {
        await probe.end({ timeout: 5 }).catch(() => {})
      }
    }
    const layout = layoutFor(schema)
    // search_path is a start-up parameter, so every pooled connection (the reserved leader one too) gets it.
    const client = postgres(url, { ...base, max: 10, connection: { search_path: schema } })
    try {
      await migrate(client, layout)
    } catch (err) {
      await client.end({ timeout: 5 }).catch(() => {})
      throw err
    }
    const orm = drizzle(client)

    // The advisory lock is session-scoped, so it needs a connection nobody else uses.
    let leaderConn: postgres.ReservedSql | undefined

    const common: Omit<Db, 'all' | 'run'> = {
      dialect: 'postgres',
      schema,
      async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
        return orm.transaction((tx) => fn(wrap(tx, common)))
      },
      // Session-level advisory lock on a reserved connection. Re-asked every pass: the same session gets `true`
      // again (the lock is reentrant for its holder), a dead session is dropped and re-reserved, and a standby
      // (HAProxy may hand one out during a failover) never counts: its locks are local to that server.
      async tryLeaderLock() {
        try {
          leaderConn ??= await client.reserve()
          const [role] = await leaderConn`select pg_is_in_recovery() as standby`
          if (role?.standby === true) {
            leaderConn.release()
            leaderConn = undefined
            return false
          }
          const [row] = await leaderConn`select pg_try_advisory_lock(hashtext(${layout.leaderKey})) as locked`
          return row?.locked === true
        } catch (err) {
          try {
            leaderConn?.release()
          } catch {
            // the connection is already gone
          }
          leaderConn = undefined
          throw err
        }
      },
      async ping() {
        try {
          await orm.execute(sql`select 1`)
          return true
        } catch {
          return false
        }
      },
      async close() {
        try {
          leaderConn?.release()
        } catch {
          // the socket is already gone (failover, watcher restart): nothing to release
        }
        leaderConn = undefined
        await client.end({ timeout: 5 }).catch(() => {})
      },
    }
    return wrap(orm, common)
  },
}

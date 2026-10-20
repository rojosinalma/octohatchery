import postgres from 'postgres'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { sql, type SQL } from 'drizzle-orm'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import type { Db, Driver, Row } from '../driver'

const MIGRATIONS = new URL('../migrations/postgres', import.meta.url).pathname
const LEADER_KEY = 'octohatchery-leader'

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
  async open(url) {
    const parsed = new URL(url)
    const ssl = parsed.searchParams.get('sslmode') === 'require' ? ('require' as const) : undefined
    const client = postgres(url, { ssl, max: 10, idle_timeout: 30, connect_timeout: 10, onnotice: () => {} })
    const orm = drizzle(client)
    await migrate(orm, { migrationsFolder: MIGRATIONS })

    // The advisory lock is session-scoped, so it needs a connection nobody else uses.
    let leaderConn: postgres.ReservedSql | undefined

    const common: Omit<Db, 'all' | 'run'> = {
      dialect: 'postgres',
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
          const [row] = await leaderConn`select pg_try_advisory_lock(hashtext(${LEADER_KEY})) as locked`
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

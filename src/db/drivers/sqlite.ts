import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { sql, type SQL } from 'drizzle-orm'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Db, Driver, Row } from '../driver'

const MIGRATIONS = new URL('../migrations/sqlite', import.meta.url).pathname

/** `sqlite:./data/x.db` → `./data/x.db`; `sqlite::memory:` → `:memory:`. */
export function sqlitePath(url: string): string {
  return url.replace(/^sqlite:(\/\/)?/, '')
}

/** One writer at a time: the SQLite stand-in for row locks. */
function createMutex() {
  let tail: Promise<void> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

export const sqliteDriver: Driver = {
  schemes: ['sqlite'],
  async open(url) {
    const path = sqlitePath(url)
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    const client = new Database(path, { create: true })
    client.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    const orm = drizzle(client)
    migrate(orm, { migrationsFolder: MIGRATIONS })
    const serialise = createMutex()
    let inTx = false

    const base: Db = {
      dialect: 'sqlite',
      async all<T extends Row>(query: SQL) {
        return orm.all<T>(query)
      },
      async run(query: SQL) {
        orm.run(query)
      },
      async transaction(fn) {
        if (inTx) return fn(base) // nested: join the outer transaction
        const body = async () => {
          inTx = true
          client.exec('BEGIN IMMEDIATE')
          try {
            const out = await fn(base)
            client.exec('COMMIT')
            return out
          } catch (err) {
            client.exec('ROLLBACK')
            throw err
          } finally {
            inTx = false
          }
        }
        return serialise(body)
      },
      async tryLeaderLock() {
        return true
      },
      async ping() {
        try {
          orm.all(sql`select 1`)
          return true
        } catch {
          return false
        }
      },
      async close() {
        client.close()
      },
    }
    return base
  },
}

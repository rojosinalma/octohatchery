import type { SQL } from 'drizzle-orm'

export type Dialect = 'sqlite' | 'postgres'
export type Row = Record<string, unknown>

/**
 * Dialect-neutral database handle. Queries are Drizzle `sql` templates (parameterised),
 * so the same statements run on SQLite and Postgres; row mapping lives in `rows.ts`.
 */
export type Db = {
  dialect: Dialect
  /** Postgres: the schema the tables live in (search_path). SQLite: undefined. */
  schema?: string
  /** Run a statement that returns rows. */
  all<T extends Row = Row>(query: SQL): Promise<T[]>
  /** Run a statement without reading rows. */
  run(query: SQL): Promise<void>
  /** Serialisable unit of work; SQLite serialises callers, Postgres opens a real transaction. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
  /**
   * True when this process holds the leader lock right now (SQLite: always). Called on every sweep pass: a
   * holder gets `true` again; a connection that died, or a server that turned out to be a standby, gives `false`
   * and the caller steps down. Never caches a previous answer.
   */
  tryLeaderLock(): Promise<boolean>
  ping(): Promise<boolean>
  close(): Promise<void>
}

export type Driver = {
  /** URL scheme this driver handles, e.g. `sqlite` or `postgres`. */
  schemes: readonly string[]
  /** Open a connection and apply pending migrations (additive only). */
  open(url: string, options?: OpenOptions): Promise<Db>
}

export type OpenOptions = {
  /** Postgres schema for the tables and the migrations journal; undefined = the driver's default. SQLite ignores it. */
  schema?: string
}

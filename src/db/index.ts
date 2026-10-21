import type { Db, OpenOptions } from './driver'
import { driverFor } from './drivers'
import { seed } from './seed'
import { log } from '../lib/log'

const logger = log('db')
let url: string | undefined
let openOptions: OpenOptions = {}
let reconnecting: Promise<void> | undefined

export type { Db, OpenOptions, Row } from './driver'

let current: Db | undefined

/** Opens the database named by `url`, migrates it, seeds the defaults and makes it the process-wide handle. */
export async function connectDb(nextUrl: string, options: OpenOptions = {}): Promise<Db> {
  const next = await driverFor(nextUrl).open(nextUrl, options)
  await seed(next)
  current = next
  url = nextUrl
  // Reconnects keep the schema the first open settled on (a detected legacy layout included).
  openOptions = { ...options, schema: next.schema ?? options.schema }
  return next
}

/**
 * Called by the background loops when a query fails: when the database no longer answers (a failover killed
 * every session, the pool holds dead sockets) the pool is thrown away and opened again. One reconnect at a time;
 * callers keep retrying on their own schedule, so a database that stays down costs one attempt per tick.
 */
export async function recoverDb(): Promise<boolean> {
  if (!current || !url) return false
  if (await current.ping()) return true
  reconnecting ??= (async () => {
    logger.warn('database stopped answering; reconnecting')
    const old = current
    try {
      current = await driverFor(url!).open(url!, openOptions)
      logger.info('database reconnected')
    } finally {
      await old?.close().catch(() => {})
      reconnecting = undefined
    }
  })()
  try {
    await reconnecting
    return true
  } catch (err) {
    logger.error('database reconnect failed', err instanceof Error ? err : String(err))
    return false
  }
}

/** The connected database; throws when `connectDb` has not run. */
export function db(): Db {
  if (!current) throw new Error('database not connected: call connectDb() first')
  return current
}

/** URL of the connected database (for comparisons only: it carries the password, never log it). */
export function dbUrl(): string | undefined {
  return current ? url : undefined
}

export function dbConnected(): boolean {
  return current !== undefined
}

export async function closeDb(): Promise<void> {
  await current?.close()
  current = undefined
}

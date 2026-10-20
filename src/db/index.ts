import type { Db } from './driver'
import { driverFor } from './drivers'
import { seed } from './seed'
import { log } from '../lib/log'

const logger = log('db')
let url: string | undefined
let reconnecting: Promise<void> | undefined

export type { Db, Row } from './driver'

let current: Db | undefined

/** Opens the database named by `url`, migrates it, seeds the defaults and makes it the process-wide handle. */
export async function connectDb(nextUrl: string): Promise<Db> {
  const next = await driverFor(nextUrl).open(nextUrl)
  await seed(next)
  current = next
  url = nextUrl
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
      current = await driverFor(url!).open(url!)
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

export function dbConnected(): boolean {
  return current !== undefined
}

export async function closeDb(): Promise<void> {
  await current?.close()
  current = undefined
}

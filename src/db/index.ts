import type { Db } from './driver'
import { driverFor } from './drivers'
import { seed } from './seed'

export type { Db, Row } from './driver'

let current: Db | undefined

/** Opens the database named by `url`, migrates it, seeds the defaults and makes it the process-wide handle. */
export async function connectDb(url: string): Promise<Db> {
  const next = await driverFor(url).open(url)
  await seed(next)
  current = next
  return next
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

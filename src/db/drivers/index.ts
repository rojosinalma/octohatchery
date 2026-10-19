import type { Driver } from '../driver'
import { postgresDriver } from './postgres'
import { sqliteDriver } from './sqlite'

/** One entry per database driver; a new driver = one file + one line here. */
export const drivers: readonly Driver[] = [sqliteDriver, postgresDriver]

/** Picks the driver by the URL scheme (`sqlite:`, `postgres://`, `postgresql://`). */
export function driverFor(url: string): Driver {
  const scheme = url.split(':', 1)[0] ?? ''
  const driver = drivers.find((d) => d.schemes.includes(scheme))
  if (!driver) throw new Error(`No database driver for scheme "${scheme}" (known: ${drivers.flatMap((d) => d.schemes).join(', ')})`)
  return driver
}

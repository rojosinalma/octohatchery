import { sql } from 'drizzle-orm'
import { db } from '../db'
import { toEvent } from '../db/rows'
import { bus } from './bus'
import type { Actor, Event } from './types'

/** Appends one audit row and emits it on the bus. */
export async function recordEvent(actor: Actor, action: string, target: string, detail: Record<string, unknown> = {}): Promise<Event> {
  const at = new Date().toISOString()
  const [row] = await db().all(sql`
    insert into events (actor, action, target, detail, at)
    values (${actor}, ${action}, ${target}, ${JSON.stringify(detail)}, ${at})
    returning *`)
  const event = toEvent(row ?? { actor, action, target, detail: JSON.stringify(detail), at })
  bus.emit('event', event)
  return event
}

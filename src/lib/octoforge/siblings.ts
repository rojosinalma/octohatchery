// Octoforge member contract v1, section 2: the sibling list (`PUT/DELETE /api/octoforge/siblings`).
import { z } from 'zod'
import manifest from '../../../octoforge.json'
import { config } from '../config'
import { recordEvent } from '../events'
import { log } from '../log'
import { settings } from '../settings'

const logger = log('octoforge')
const ACTOR = 'octoforge'
export const SIBLINGS_KEY = 'octoforge_siblings'
export const MAX_MEMBERS = 50

/** Only http(s) URLs: a `javascript:` link or icon must never reach the page. */
const WebUrl = z
  .string()
  .max(2048)
  .refine((s) => {
    try {
      return ['http:', 'https:'].includes(new URL(s).protocol)
    } catch {
      return false
    }
  }, 'must be an absolute http(s) URL')

const Entry = z.object({ title: z.string().trim().min(1).max(100), url: WebUrl, icon: WebUrl })

export const SiblingList = z.object({
  forge: Entry,
  members: z.array(Entry.extend({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/) })).max(MAX_MEMBERS),
  updated_at: z.iso.datetime({ offset: true }),
})
export type SiblingList = z.infer<typeof SiblingList>

/** One link in the switcher; `current` marks this app. */
export type Sibling = { name: string; title: string; url: string; icon: string; current: boolean }
/** `staleSince` is set when Octoforge has not resent the list for `siblings_stale_minutes`: the links stay, marked old. */
export type Switcher = { forge: Omit<Sibling, 'name' | 'current'>; members: Sibling[]; updatedAt: string; staleSince?: string }

/** The list as stored: what Octoforge sent plus when this member got it (Octoforge's `updated_at` may not move on a resend). */
const Stored = SiblingList.extend({ received_at: z.iso.datetime({ offset: true }) })
type Stored = z.infer<typeof Stored>

const content = ({ forge, members }: SiblingList) => JSON.stringify({ forge, members })

function parse(raw: string): Stored | undefined {
  try {
    return Stored.parse(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/** True when this node runs under Octoforge (`OCTOFORGE_TOKEN` set). Standalone, nothing Octoforge-related is shown. */
export function underOctoforge(): boolean {
  try {
    return Boolean(config().octoforgeToken)
  } catch {
    return false
  }
}

/** Stores the list Octoforge sent; an audit event only when its content changed (Octoforge resends it every hour). */
export async function storeSiblings(list: SiblingList): Promise<{ changed: boolean }> {
  const before = parse(await settings.fetch(SIBLINGS_KEY, ''))
  const stored: Stored = { forge: list.forge, members: list.members, updated_at: list.updated_at, received_at: new Date().toISOString() }
  await settings.set(SIBLINGS_KEY, JSON.stringify(stored))
  const changed = !before || content(before) !== content(list)
  if (changed) {
    logger.info(`sibling list stored: ${list.members.length} members`)
    await recordEvent(ACTOR, 'siblings.updated', 'siblings', { members: list.members.map((m) => m.name) })
  } else logger.debug('sibling list resent, unchanged')
  return { changed }
}

export async function dropSiblings(): Promise<{ removed: boolean }> {
  const removed = await settings.delete(SIBLINGS_KEY)
  if (removed) {
    logger.info('sibling list removed')
    await recordEvent(ACTOR, 'siblings.cleared', 'siblings')
  }
  return { removed }
}

/** What the member switcher renders; undefined (no switcher) without `OCTOFORGE_TOKEN` or a valid stored list. */
export async function switcher(): Promise<Switcher | undefined> {
  if (!underOctoforge()) return undefined
  const raw = await settings.fetch(SIBLINGS_KEY, '')
  if (!raw) return undefined
  const list = parse(raw)
  if (!list) {
    logger.warn(`stored ${SIBLINGS_KEY} is not a valid sibling list; no switcher shown`)
    return undefined
  }
  const staleMs = (await settings.fetchInt('siblings_stale_minutes', 180)) * 60_000
  const stale = staleMs > 0 && Date.now() - Date.parse(list.received_at) > staleMs
  return {
    forge: list.forge,
    members: list.members.map((m) => ({ ...m, current: m.name === manifest.name })),
    updatedAt: list.updated_at,
    ...(stale ? { staleSince: list.received_at } : {}),
  }
}

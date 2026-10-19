import { sql } from 'drizzle-orm'
import { db, dbConnected } from '../db'

/** Every tunable with its default; `fetch` falls back to these when the row is missing. */
export const SETTING_DEFAULTS: Record<string, string> = {
  poll_interval_s: '300',
  stale_runner_minutes: '5',
  retention_days: '30',
  sse_max_clients: '20',
  sse_idle_s: '300',
  log_level: 'info',
  buildkit_host: 'tcp://octohatchery-buildkitd:1234',
  scheduler_tick_s: '5',
  heartbeat_s: '15',
}

const TTL_MS = 5_000

type Cached = { value: string | undefined; at: number }
const cache = new Map<string, Cached>()
let refreshing: Promise<void> | undefined

async function load(): Promise<void> {
  if (!dbConnected()) return
  const rows = await db().all<{ key: string; value: string }>(sql`select key, value from settings`)
  const now = Date.now()
  const seen = new Set<string>()
  for (const r of rows) {
    cache.set(r.key, { value: r.value, at: now })
    seen.add(r.key)
  }
  for (const key of cache.keys()) if (!seen.has(key)) cache.set(key, { value: undefined, at: now })
}

function stale(entry: Cached | undefined): boolean {
  return !entry || Date.now() - entry.at > TTL_MS
}

export const settings = {
  /** Value from the DB (cached ≤ 5 s) or `fallback`. */
  async fetch(key: string, fallback: string): Promise<string> {
    if (stale(cache.get(key))) {
      refreshing ??= load().finally(() => (refreshing = undefined))
      await refreshing
    }
    return cache.get(key)?.value ?? fallback
  },

  async fetchInt(key: string, fallback: number): Promise<number> {
    const n = Number.parseInt(await this.fetch(key, String(fallback)), 10)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  },

  /** Synchronous read of the cache for hot paths (logging); kicks a refresh when stale. */
  peek(key: string, fallback: string): string {
    const entry = cache.get(key)
    if (stale(entry) && !refreshing && dbConnected()) {
      refreshing = load()
        .catch(() => undefined)
        .finally(() => (refreshing = undefined))
    }
    return entry?.value ?? fallback
  },

  async set(key: string, value: string): Promise<void> {
    const now = new Date().toISOString()
    await db().run(sql`
      insert into settings (key, value, updated_at) values (${key}, ${value}, ${now})
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`)
    cache.set(key, { value, at: Date.now() })
  },

  /** Defaults overlaid with stored rows. */
  async all(): Promise<Record<string, string>> {
    await load()
    const out: Record<string, string> = { ...SETTING_DEFAULTS }
    for (const [k, v] of cache) if (v.value !== undefined) out[k] = v.value
    return out
  },

  /** Tests only. */
  reset(): void {
    cache.clear()
  },
}

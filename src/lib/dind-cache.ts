import { sql } from 'drizzle-orm'
import { db } from '../db'
import { backend } from './backends'
import { log } from './log'
import { settings } from './settings'
import { listRunnerTypes, slotsView } from './store'

const logger = log('docker')

/** Where a Docker-in-Docker daemon keeps images, containers, volumes and its build cache. */
export const DAEMON_STORE = '/var/lib/docker'
/** Exit code of the cleanup script when the store was over its cap and has been emptied. */
export const CLEAN_WIPED = 10
const CLEAN_TIMEOUT_MS = 120_000

/** Volume names allow `[a-zA-Z0-9][a-zA-Z0-9_.-]`; a repository `owner/name` becomes `owner.name`. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_.-]+/g, '.')
}

/** The volumes of one (type, repository) pool are `<prefix><n>`, n = 0 … slots − 1. */
export function cacheVolumePrefix(type: string, repo: string): string {
  return `octohatchery-cache-${slug(type)}-${slug(repo)}-`
}

export function cacheVolumeName(type: string, repo: string, n: number): string {
  return `${cacheVolumePrefix(type, repo)}${n}`
}

/** Index of a pool volume, or -1 when the name is not one of this pool's. */
export function cacheVolumeIndex(name: string, type: string, repo: string): number {
  const prefix = cacheVolumePrefix(type, repo)
  if (!name.startsWith(prefix)) return -1
  const rest = name.slice(prefix.length)
  return /^\d+$/.test(rest) ? Number(rest) : -1
}

/**
 * Volumes picked but not yet mounted by a container. The engine reports a volume as in use only once a container
 * mounts it, so between the pick and the sidecar's create this set is what keeps a second spawn (or the sweep) off it.
 * One node runs per engine, so a lock in this process is enough.
 */
const leasing = new Set<string>()
let lock: Promise<unknown> = Promise.resolve()

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn)
  lock = run.catch(() => undefined)
  return run
}

/**
 * Picks the lowest free volume of the (host, type, repository) pool, creating it when missing, and holds it until
 * `releaseLease`. The pool has as many volumes as the type has slots on the host, so a free one exists unless a
 * container of an older run still holds one; then the job gets an empty daemon (undefined).
 */
export function leaseCacheVolume(input: { host: string; type: string; repo: string; slots: number }): Promise<string | undefined> {
  return withLock(async () => {
    const be = backend()
    const used = new Set((await be.listCacheVolumes()).filter((v) => v.inUse).map((v) => v.name))
    for (let n = 0; n < Math.max(1, input.slots); n++) {
      const name = cacheVolumeName(input.type, input.repo, n)
      if (used.has(name) || leasing.has(name)) continue
      leasing.add(name)
      try {
        await be.createCacheVolume({ name, host: input.host, type: input.type, repo: input.repo })
      } catch (err) {
        leasing.delete(name)
        throw err
      }
      return name
    }
    logger.warn(`every cache volume of ${input.type} for ${input.repo} is in use; this job gets an empty daemon`)
    return undefined
  })
}

/** Called once the sidecar mounts the volume (the engine now reports it in use) or the spawn gave up. */
export function releaseLease(name: string): void {
  leasing.delete(name)
}

/**
 * Run in the daemon before the runner starts: nothing of an earlier job may still run or be found (a container with a
 * restart policy comes back with the daemon), only images and the build cache stay. A store above `$1` KB is emptied.
 */
export const CLEAN_SCRIPT = [
  'set -e',
  'ids=$(docker ps -aq)',
  '[ -z "$ids" ] || docker rm -f -v $ids >/dev/null',
  'docker volume prune -af >/dev/null',
  'docker network prune -f >/dev/null',
  `kb=$(du -skx ${DAEMON_STORE} | cut -f1)`,
  'if [ "$kb" -gt "$1" ]; then',
  '  docker system prune -af --volumes >/dev/null',
  '  docker builder prune -af >/dev/null',
  `  exit ${CLEAN_WIPED}`,
  'fi',
].join('\n')

/** Cleans a warm daemon before its job; resolves `kept` or `wiped`, throws when the cleanup fails. */
export async function cleanCacheDaemon(sidecarId: string, runnerName: string): Promise<'kept' | 'wiped'> {
  const maxGb = await settings.fetchInt('dind_cache_max_gb', 20)
  const code = await backend().exec(sidecarId, ['sh', '-c', CLEAN_SCRIPT, 'clean', String(Math.max(1, maxGb) * 1024 * 1024)], { timeoutMs: CLEAN_TIMEOUT_MS })
  if (code === CLEAN_WIPED) {
    logger.info(`${runnerName}: cache store was above ${maxGb} GB and has been emptied`)
    return 'wiped'
  }
  if (code !== 0) throw new Error(`${runnerName}: cleaning the cached daemon store failed (exit ${code})`)
  return 'kept'
}

/** Newest runner start per (type, repository) on a host, ISO strings. */
async function lastRuns(host: string): Promise<Map<string, string>> {
  const rows = await db().all<{ type: string; repo: string | null; last: string | null }>(
    sql`select type, repo, max(created_at) as last from runners where host = ${host} and repo is not null group by type, repo`,
  )
  return new Map(rows.filter((r) => r.repo && r.last).map((r) => [`${r.type}\n${r.repo}`, String(r.last)]))
}

/**
 * Removes the cache volumes of this host that no job may use again: the type is gone or no longer caches, the
 * volume's index is at or above the type's slot count here, or no runner of that type and repository started on this
 * host for `dind_cache_idle_days`. Volumes in use or being leased are kept.
 */
export function sweepCacheVolumes(host: string, nowMs = Date.now()): Promise<string[]> {
  return withLock(async () => {
    const be = backend()
    const volumes = (await be.listCacheVolumes()).filter((v) => v.host === host)
    if (!volumes.length) return []
    const types = new Map((await listRunnerTypes()).map((t) => [t.name, t]))
    const slots = new Map((await slotsView()).filter((s) => s.host === host).map((s) => [s.type, s.count]))
    const idleDays = await settings.fetchInt('dind_cache_idle_days', 7)
    const runs = await lastRuns(host)
    const removed: string[] = []
    for (const v of volumes) {
      if (v.inUse || leasing.has(v.name)) continue
      const type = types.get(v.type)
      const index = cacheVolumeIndex(v.name, v.type, v.repo)
      const last = runs.get(`${v.type}\n${v.repo}`)
      let reason: string | undefined
      if (!type || type.docker !== 'dind' || type.dockerCache !== 'repo') reason = 'the template no longer keeps a Docker cache'
      else if (index < 0 || index >= (slots.get(v.type) ?? 0)) reason = 'above the slot count'
      else if (idleDays > 0 && (!last || nowMs - Date.parse(last) > idleDays * 86_400_000)) reason = `no job for ${idleDays} days`
      if (!reason) continue
      try {
        await be.removeVolume(v.name)
        logger.info(`removed cache volume ${v.name}: ${reason}`)
        removed.push(v.name)
      } catch (err) {
        logger.warn(`remove cache volume ${v.name} failed`, err instanceof Error ? err.message : String(err))
      }
    }
    return removed
  })
}

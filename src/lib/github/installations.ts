import { log } from '../log'

const logger = log('github')

/** One installation of the GitHub App: the account it is installed on and what that account accepted. */
export type Installation = {
  id: number
  /** Login of the user or organisation. */
  account: string
  /** `User` or `Organization`, as GitHub spells it. */
  accountType: string
  /** Permission key → level the installation accepted. */
  permissions: Record<string, string>
}

/** The installations a source knows, with the one `GITHUB_APP_INSTALLATION_ID` names as the default. */
export type InstallationSource = {
  /** `GITHUB_APP_INSTALLATION_ID` when set. */
  defaultId?: number
  /** Every installation, from the cache while it is fresh; `refresh` asks GitHub now. */
  list(opts?: { refresh?: boolean }): Promise<Installation[]>
  /** The installation on `owner` (case-insensitive); a miss asks GitHub again, at most once per `missRefetchMs`. */
  forOwner(owner: string): Promise<Installation | undefined>
  /** Drops the cached list: the next call asks GitHub. */
  invalidate(): void
}

/** How long the list is reused before GitHub is asked again. */
export const INSTALLATIONS_TTL_MS = 5 * 60_000
/** A miss (an owner the list does not know) re-fetches at most this often, so unknown owners cannot flood GitHub. */
export const INSTALLATIONS_MISS_REFETCH_MS = 30_000
/** Most installations one App is expected to have; the list stops there. */
export const MAX_INSTALLATIONS = 100

type Options = { ttlMs?: number; missRefetchMs?: number; now?: () => number; defaultId?: number }

/**
 * Caches `fetchAll` (the App's `GET /app/installations`) with a TTL. One fetch runs at a time; when a refresh fails
 * and an older list exists, the older list is served and the failure logged, so a GitHub hiccup never blocks a job.
 */
export function installationIndex(fetchAll: () => Promise<Installation[]>, opts: Options = {}): InstallationSource {
  const ttl = opts.ttlMs ?? INSTALLATIONS_TTL_MS
  const missRefetch = opts.missRefetchMs ?? INSTALLATIONS_MISS_REFETCH_MS
  const now = opts.now ?? Date.now
  let cache: { at: number; list: Installation[] } | undefined
  let inFlight: Promise<Installation[]> | undefined

  const fetchNow = (): Promise<Installation[]> => {
    inFlight ??= fetchAll()
      .then((list) => {
        const capped = list.slice(0, MAX_INSTALLATIONS)
        cache = { at: now(), list: capped }
        return capped
      })
      .finally(() => (inFlight = undefined))
    return inFlight
  }

  const list = async ({ refresh = false } = {}): Promise<Installation[]> => {
    if (!refresh && cache && now() - cache.at < ttl) return cache.list
    try {
      return await fetchNow()
    } catch (err) {
      if (!cache || refresh) throw err
      logger.warn(`GET /app/installations failed; using the list from ${Math.round((now() - cache.at) / 1000)} s ago`, err instanceof Error ? err.message : String(err))
      return cache.list
    }
  }

  const find = (items: Installation[], owner: string) => items.find((i) => i.account.toLowerCase() === owner.toLowerCase())

  return {
    defaultId: opts.defaultId,
    list,
    async forOwner(owner) {
      const hit = find(await list(), owner)
      if (hit || !cache || now() - cache.at < missRefetch) return hit
      return find(await list({ refresh: true }), owner)
    },
    invalidate() {
      cache = undefined
    },
  }
}

/** Where the account's owner manages (and accepts permissions for) one installation. */
export function installationUrl(inst: { id: number; account?: string; accountType?: string }): string {
  return inst.accountType === 'Organization' && inst.account
    ? `https://github.com/organizations/${inst.account}/settings/installations/${inst.id}`
    : `https://github.com/settings/installations/${inst.id}`
}

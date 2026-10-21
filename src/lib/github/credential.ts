import { createHash } from 'node:crypto'
import { z } from 'zod'
import { config, type GitHubAuthKind } from '../config'
import { log } from '../log'
import { settings } from '../settings'

const logger = log('github')

/** Settings key of the credential Octoforge delivered (one JSON value, plain text). */
export const DELIVERED_KEY = 'octoforge_github'
/** Settings key of the webhook secret generated for a delivered token when `GITHUB_WEBHOOK_SECRET` is unset. */
export const WEBHOOK_SECRET_KEY = 'octoforge_webhook_secret'

export type CredentialSource = 'env' | 'octoforge' | 'none'

/** The GitHub credential this node runs with. A delivered one wins over the env values. */
export type GitHubCredential = {
  mode: GitHubAuthKind
  source: CredentialSource
  appId?: string
  privateKey?: string
  installationId?: string
  token?: string
  webhookSecret?: string
  /** Who GitHub said the credential is when it was delivered: the token's login or the App's slug. */
  login?: string
  appSlug?: string
}

/** What `PUT /api/octoforge/github` stores under `octoforge_github`. */
export const DeliveredCredential = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('pat'), token: z.string().min(1), login: z.string().optional(), delivered_at: z.string() }),
  z.object({
    mode: z.literal('app'),
    app_id: z.string().regex(/^\d+$/),
    private_key: z.string().min(1),
    webhook_secret: z.string().min(1),
    installation_id: z.string().regex(/^\d+$/).optional(),
    app_slug: z.string().optional(),
    delivered_at: z.string(),
  }),
])
export type DeliveredCredential = z.infer<typeof DeliveredCredential>

function fromEnv(): GitHubCredential {
  const cfg = config()
  return {
    mode: cfg.githubAuth,
    source: cfg.githubAuth === 'none' ? 'none' : 'env',
    appId: cfg.githubAppId,
    privateKey: cfg.githubAppPrivateKey,
    installationId: cfg.githubAppInstallationId,
    token: cfg.githubToken,
    webhookSecret: cfg.githubWebhookSecret,
  }
}

function fromDelivered(d: DeliveredCredential, generatedSecret: string | undefined): GitHubCredential {
  if (d.mode === 'app') {
    return { mode: 'app', source: 'octoforge', appId: d.app_id, privateKey: d.private_key, installationId: d.installation_id, webhookSecret: d.webhook_secret, appSlug: d.app_slug }
  }
  // A token brings no webhook secret: the env one when set, else the one generated at delivery.
  return { mode: 'pat', source: 'octoforge', token: d.token, webhookSecret: config().githubWebhookSecret ?? generatedSecret, login: d.login }
}

/** Hash over every field of the credential; never logged. */
function fingerprint(c: GitHubCredential): string {
  return createHash('sha256')
    .update(JSON.stringify([c.mode, c.source, c.appId, c.privateKey, c.installationId, c.token, c.webhookSecret, c.login, c.appSlug]))
    .digest('hex')
}

let current: { credential: GitHubCredential; fingerprint: string } | undefined
let lastInvalidRaw: string | undefined

/** The credential in use; until the first `loadGitHubCredential` it is the env one. Synchronous for hot paths. */
export function githubCredential(): GitHubCredential {
  current ??= { credential: fromEnv(), fingerprint: fingerprint(fromEnv()) }
  return current.credential
}

/**
 * Re-reads the delivered credential from settings (cached ≤ 5 s) and makes it current. Returns true when it differs
 * from the one in use; the caller then drops the GitHub client so the next call builds one from it.
 */
export async function loadGitHubCredential(): Promise<boolean> {
  githubCredential()
  const raw = await settings.fetch(DELIVERED_KEY, '')
  let next = fromEnv()
  if (raw) {
    let parsed: ReturnType<typeof DeliveredCredential.safeParse> | undefined
    try {
      parsed = DeliveredCredential.safeParse(JSON.parse(raw))
    } catch {
      parsed = undefined
    }
    if (parsed?.success) {
      next = fromDelivered(parsed.data, (await settings.fetch(WEBHOOK_SECRET_KEY, '')) || undefined)
    } else if (raw !== lastInvalidRaw) {
      logger.warn(`setting ${DELIVERED_KEY} is not a valid credential; using the env values`)
    }
    lastInvalidRaw = parsed?.success ? undefined : raw
  }
  const fp = fingerprint(next)
  if (fp === current!.fingerprint) return false
  current = { credential: next, fingerprint: fp }
  return true
}

/** Tests only: forget the resolved credential (the next read starts from the env again). */
export function resetGitHubCredential(): void {
  current = undefined
  lastInvalidRaw = undefined
}

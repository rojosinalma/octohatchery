// Octoforge member contract v1, section 2: GitHub credential delivery (`PUT/DELETE /api/octoforge/github`).
import { App } from '@octokit/app'
import { Octokit } from '@octokit/rest'
import { createPrivateKey, randomBytes } from 'node:crypto'
import { config } from '../config'
import { recordEvent } from '../events'
import { setGitHub } from '../github/auth'
import { DELIVERED_KEY, githubCredential, loadGitHubCredential, WEBHOOK_SECRET_KEY, type DeliveredCredential } from '../github/credential'
import { githubMessage } from '../github/rest'
import { log } from '../log'
import { resetGitHubCaches } from '../service'
import { settings } from '../settings'
import { ServiceError } from '../types'

const logger = log('github')
const ACTOR = 'octoforge'

export type GitHubDelivery =
  | { mode: 'pat'; token: string }
  | { mode: 'app'; app_id: string; private_key: string; webhook_secret: string; installation_id?: string }

/** Who a credential is on GitHub. Swappable so tests never reach GitHub. */
export type GitHubVerifier = {
  /** `GET /user` with the token: its login. */
  pat(token: string): Promise<{ login: string }>
  /** `GET /app` with a JWT signed by the key: the App's slug. */
  app(appId: string, privateKey: string): Promise<{ appSlug: string }>
}

const githubVerifier: GitHubVerifier = {
  async pat(token) {
    const res = await new Octokit({ auth: token }).rest.users.getAuthenticated()
    return { login: res.data.login }
  },
  async app(appId, privateKey) {
    const res = await new App({ appId, privateKey, Octokit }).octokit.request('GET /app')
    return { appSlug: res.data?.slug ?? `app-${appId}` }
  },
}

let verifier = githubVerifier

/** Tests only: replace the GitHub checks (undefined restores the real ones). */
export function setGitHubVerifier(next: GitHubVerifier | undefined): void {
  verifier = next ?? githubVerifier
}

/** GitHub could not be asked (network, 5xx): the route answers 502. */
export class GitHubUnreachable extends ServiceError {
  constructor(message: string) {
    super(message, 'unavailable')
  }
}

/** GitHub's answer to a refused or failed check, as a ServiceError the route can map. */
function verifyFailed(what: string, err: unknown): ServiceError {
  const status = (err as { status?: number }).status
  if (status !== undefined && status >= 400 && status < 500) return new ServiceError(`GitHub refused the ${what}: ${githubMessage(err)}`, 'invalid')
  return new GitHubUnreachable(`GitHub did not answer the ${what} check: ${githubMessage(err)}`)
}

/**
 * Re-reads the delivered credential; when it changed, drops the GitHub client and cached GitHub answers so the
 * next call uses the new one. Runs at start-up, after a delivery and on every scheduler pass (cluster pick-up).
 */
export async function refreshGitHubCredential(): Promise<boolean> {
  if (!(await loadGitHubCredential())) return false
  setGitHub(undefined)
  resetGitHubCaches()
  const cred = githubCredential()
  logger.info(`credential changed: ${cred.mode} from ${cred.source}`)
  return true
}

/** The token's webhook secret: env when set, else the stored generated one, else a new one stored now. */
async function tokenWebhookSecret(): Promise<void> {
  if (config().githubWebhookSecret) return
  if (await settings.fetch(WEBHOOK_SECRET_KEY, '')) return
  await settings.set(WEBHOOK_SECRET_KEY, randomBytes(32).toString('hex'))
  logger.info('generated a webhook secret for the delivered token')
}

/** Checks the credential against GitHub, stores it under `octoforge_github` and switches to it. Nothing is stored on failure. */
export async function deliverGitHub(input: GitHubDelivery): Promise<{ login?: string; appSlug?: string }> {
  const deliveredAt = new Date().toISOString()
  let stored: DeliveredCredential
  let identity: { login?: string; appSlug?: string }
  if (input.mode === 'pat') {
    let login
    try {
      ;({ login } = await verifier.pat(input.token))
    } catch (err) {
      logger.warn('octoforge delivery: GET /user failed', githubMessage(err))
      throw verifyFailed('token', err)
    }
    logger.info(`octoforge delivery: GET /user ok (${login})`)
    await tokenWebhookSecret()
    stored = { mode: 'pat', token: input.token, login, delivered_at: deliveredAt }
    identity = { login }
  } else {
    const privateKey = input.private_key.replace(/\\n/g, '\n')
    try {
      createPrivateKey(privateKey)
    } catch {
      throw new ServiceError('private_key is not a readable PEM private key', 'invalid')
    }
    let appSlug
    try {
      ;({ appSlug } = await verifier.app(input.app_id, privateKey))
    } catch (err) {
      logger.warn(`octoforge delivery: GET /app (app ${input.app_id}) failed`, githubMessage(err))
      throw verifyFailed('App credentials', err)
    }
    logger.info(`octoforge delivery: GET /app ok (${appSlug})`)
    stored = { mode: 'app', app_id: input.app_id, private_key: privateKey, webhook_secret: input.webhook_secret, installation_id: input.installation_id, app_slug: appSlug, delivered_at: deliveredAt }
    identity = { appSlug }
  }
  await settings.set(DELIVERED_KEY, JSON.stringify(stored))
  await refreshGitHubCredential()
  await recordEvent(ACTOR, 'github.delivered', input.mode, input.mode === 'pat' ? { login: identity.login } : { appId: input.app_id, appSlug: identity.appSlug, installationId: input.installation_id ?? null })
  return identity
}

/** Drops the delivered credential; the node goes back to its env values. The generated webhook secret stays for a later token. */
export async function dropGitHub(): Promise<{ removed: boolean }> {
  const removed = await settings.delete(DELIVERED_KEY)
  await refreshGitHubCredential()
  await recordEvent(ACTOR, 'github.dropped', githubCredential().mode, { removed, source: githubCredential().source })
  return { removed }
}

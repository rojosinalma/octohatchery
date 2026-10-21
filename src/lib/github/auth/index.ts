import { config } from '../../config'
import { githubCredential } from '../credential'
import type { GitHubAuthAdapter, GitHubClient } from '../types'
import { appAuth } from './app'
import { noneAuth } from './none'
import { patAuth } from './pat'
import { unconfiguredGitHub } from './unconfigured'

/** One entry per auth method; a new method = one file + one line here. */
export const githubAuthAdapters: readonly GitHubAuthAdapter[] = [appAuth, patAuth, noneAuth]

export function githubAuthFor(kind: string): GitHubAuthAdapter {
  const adapter = githubAuthAdapters.find((a) => a.kind === kind)
  if (!adapter) throw new Error(`Unknown GITHUB_AUTH "${kind}" (known: ${githubAuthAdapters.map((a) => a.kind).join(', ')})`)
  return adapter
}

let current: GitHubClient | undefined

/**
 * The process-wide GitHub client, created on first use from the current credential (delivered by Octoforge, else
 * `GITHUB_AUTH`). `refreshGitHubCredential` drops it when the credential changes.
 */
export function github(): GitHubClient {
  if (!current) {
    const cred = githubCredential()
    current = cred.mode === 'none' && config().githubAwaitingDelivery ? unconfiguredGitHub() : githubAuthFor(cred.mode).create()
  }
  return current
}

/** Drops the client (credential changed) or, in tests, injects one. */
export function setGitHub(client: GitHubClient | undefined): void {
  current = client
}

export type { GitHubClient } from '../types'

import { config } from '../../config'
import type { GitHubAuthAdapter, GitHubClient } from '../types'
import { appAuth } from './app'
import { noneAuth } from './none'
import { patAuth } from './pat'

/** One entry per auth method; a new method = one file + one line here. */
export const githubAuthAdapters: readonly GitHubAuthAdapter[] = [appAuth, patAuth, noneAuth]

export function githubAuthFor(kind: string): GitHubAuthAdapter {
  const adapter = githubAuthAdapters.find((a) => a.kind === kind)
  if (!adapter) throw new Error(`Unknown GITHUB_AUTH "${kind}" (known: ${githubAuthAdapters.map((a) => a.kind).join(', ')})`)
  return adapter
}

let current: GitHubClient | undefined

/** The process-wide GitHub client, created from `GITHUB_AUTH` on first use. */
export function github(): GitHubClient {
  current ??= githubAuthFor(config().githubAuth).create()
  return current
}

/** Tests only: inject a client (or reset with undefined). */
export function setGitHub(client: GitHubClient | undefined): void {
  current = client
}

export type { GitHubClient } from '../types'

import { settings } from '../settings'
import type { Installation, InstallationSource } from './installations'

/** A GitHub login: letters, digits and single hyphens, at most 39 characters. */
export const ACCOUNT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

/**
 * Which installations this instance serves (`github_accounts`):
 * - `listed`: the setting names the accounts;
 * - `default`: the setting is empty and `GITHUB_APP_INSTALLATION_ID` is set, so only that installation;
 * - `all`: the setting is empty and no default installation is set, so every installation.
 */
export type AccountPolicy = { kind: 'listed'; accounts: string[] } | { kind: 'default'; installationId: number } | { kind: 'all' }

/** Comma-separated logins → lowercased, trimmed, without duplicates or empties. */
export function parseAccounts(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
}

/** Reads `github_accounts` (no GitHub call). */
export async function accountPolicy(defaultId: number | undefined): Promise<AccountPolicy> {
  const accounts = parseAccounts(await settings.fetch('github_accounts', ''))
  if (accounts.length) return { kind: 'listed', accounts }
  if (defaultId !== undefined) return { kind: 'default', installationId: defaultId }
  return { kind: 'all' }
}

/** Whether the installation (by id when known, else by account) is served. */
export function allows(policy: AccountPolicy, inst: Pick<Installation, 'account'> & { id?: number }): boolean {
  if (policy.kind === 'all') return true
  if (policy.kind === 'listed') return policy.accounts.includes(inst.account.toLowerCase())
  return inst.id === policy.installationId
}

/** Why an account is not served, in words for a log line, an event and an API error. */
export function refusal(policy: AccountPolicy, account: string): string {
  return policy.kind === 'listed'
    ? `account ${account} is not in github_accounts (${policy.accounts.join(', ')})`
    : `account ${account} is not the default installation (GITHUB_APP_INSTALLATION_ID ${policy.kind === 'default' ? policy.installationId : '?'}); tick it in Settings → GitHub`
}

/**
 * Why a repo of `owner` is not served, or null when it is (always null without installations). A delivery's
 * `installationId` decides the default policy without asking GitHub; otherwise the owner's installation is looked up.
 */
export async function notServedReason(installs: InstallationSource | undefined, owner: string, installationId?: number): Promise<string | null> {
  if (!installs) return null
  const policy = await accountPolicy(installs.defaultId)
  if (policy.kind === 'all') return null
  if (policy.kind === 'listed') return allows(policy, { account: owner }) ? null : refusal(policy, owner)
  const id = installationId ?? (await installs.forOwner(owner).catch(() => undefined))?.id
  return id === policy.installationId ? null : refusal(policy, owner)
}

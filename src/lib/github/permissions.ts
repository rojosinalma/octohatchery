import type { GitHubAuthKind } from '../config'

export type PermissionLevel = 'read' | 'write'
/** What the token proved: a definite level, a definite absence, or nothing (fine-grained tokens expose no grant list). */
export type GrantedLevel = 'read' | 'write' | 'none' | 'unknown'

export type RequiredPermission = {
  /** GitHub permission key as the API spells it (`actions`, `administration`, …). */
  key: string
  level: PermissionLevel
  /** What the app does with it. */
  why: string
  /** What stops working without it. */
  breaks: string
  /** Auth modes that need it; absent = every mode. */
  modes?: GitHubAuthKind[]
}

/** The repository permissions OctoHatchery needs; the docs table and the GitHub App manifest mirror this list. */
export const REQUIRED_PERMISSIONS: readonly RequiredPermission[] = [
  {
    key: 'metadata',
    level: 'read',
    why: 'Required by GitHub for every App; reads repository names and visibility.',
    breaks: 'Nothing works: GitHub refuses every call.',
  },
  {
    key: 'administration',
    level: 'write',
    why: 'Registers a just-in-time runner for each job and removes it afterwards.',
    breaks: 'Nothing runs: no runner can be registered.',
  },
  {
    key: 'actions',
    level: 'write',
    why: 'Lists queued jobs and workflow runs, downloads job logs.',
    breaks: 'The polling fallback is blind: jobs the webhook misses stay queued; final job logs cannot be fetched.',
  },
  {
    key: 'contents',
    level: 'write',
    why: 'Reads workflow files and writes them for apply_runs_on in pull request or commit mode.',
    breaks: 'apply_runs_on cannot read or change workflows; the snippet mode still works.',
  },
  {
    key: 'workflows',
    level: 'write',
    why: 'GitHub requires it to change files under .github/workflows.',
    breaks: 'apply_runs_on in pull request or commit mode fails when it writes a workflow file.',
  },
  {
    key: 'pull_requests',
    level: 'write',
    why: 'Opens the pull request for apply_runs_on in pull request mode.',
    breaks: 'apply_runs_on in pull request mode fails after the branch is pushed.',
  },
  {
    key: 'webhooks',
    level: 'write',
    why: 'Creates the workflow_job webhook on each adopted repository (token mode only; the App delivers its own events).',
    breaks: 'Adopted repositories get no webhook and rely on polling.',
    modes: ['pat'],
  },
]

/** Permissions a run of `apply_runs_on` in the given mode needs before it writes anything. */
export const RUNS_ON_PERMISSIONS: Record<'pr' | 'commit', string[]> = {
  pr: ['contents', 'workflows', 'pull_requests'],
  commit: ['contents', 'workflows'],
}

export type PermissionReport = {
  source: GitHubAuthKind
  /** Permission key → granted level as GitHub reports it (`read`, `write`, `admin`, …). */
  granted: Record<string, string>
  account?: string
  accountType?: string
  installationId?: number
  repoCount?: number
  appSlug?: string
  /** Owner of the App (`User` or `Organization`); decides where its settings live. */
  appOwner?: { login: string; type: string }
  /** Free-text caveat for the operator (fine-grained tokens, probe skipped, …). */
  note?: string
}

export type PermissionRow = RequiredPermission & {
  granted: GrantedLevel
  /** true = satisfied, false = definitely missing, null = cannot tell. */
  ok: boolean | null
}

export type GitHubStatus = {
  /** Source answers and no required permission is definitely missing. */
  ok: boolean
  source: GitHubAuthKind
  account?: string
  installationId?: number
  repoCount?: number
  appSlug?: string
  /** Links the operator needs to fix things; absent when the source does not have them. */
  appUrl?: string
  permissionsUrl?: string
  installUrl?: string
  webhookUrl?: string
  note?: string
  permissions: PermissionRow[]
  /** Keys that are definitely missing (`<key>:<level>`). */
  missing: string[]
  checkedAt: string
  /** Set when GitHub could not be asked; the rows are then all `unknown`. */
  error?: string
}

const LEVEL_RANK: Record<string, number> = { none: 0, read: 1, write: 2, admin: 3 }

/** Normalises what GitHub reports (`read`, `write`, `admin`, missing) to a level we can compare. */
export function grantedLevel(granted: Record<string, string>, key: string): GrantedLevel {
  const raw = granted[key]
  if (raw === undefined) return 'none'
  if (raw === 'unknown') return 'unknown'
  if (raw === 'admin' || raw === 'write') return 'write'
  if (raw === 'read') return 'read'
  return 'none'
}

/** true when the granted level covers the required one, false when it definitely does not, null when unknown. */
export function covers(granted: GrantedLevel, required: PermissionLevel): boolean | null {
  if (granted === 'unknown') return null
  return LEVEL_RANK[granted]! >= LEVEL_RANK[required]!
}

export function requiredFor(source: GitHubAuthKind): RequiredPermission[] {
  return REQUIRED_PERMISSIONS.filter((p) => !p.modes || p.modes.includes(source))
}

/** Rows for the dashboard; `missing` lists only definite gaps so an unreachable GitHub never raises a false alarm. */
export function evaluate(report: PermissionReport): { permissions: PermissionRow[]; missing: string[] } {
  const nothingKnown = report.source === 'none' && Object.keys(report.granted).length === 0
  const permissions = requiredFor(report.source).map((p) => {
    const granted = nothingKnown ? 'unknown' : grantedLevel(report.granted, p.key)
    return { ...p, granted, ok: covers(granted, p.level) }
  })
  return { permissions, missing: permissions.filter((p) => p.ok === false).map((p) => `${p.key}:${p.level}`) }
}

/** Where the operator edits the App's permissions and accepts them on the installation. */
export function githubLinks(report: PermissionReport): Pick<GitHubStatus, 'appUrl' | 'permissionsUrl' | 'installUrl'> {
  if (report.source === 'pat') return { permissionsUrl: 'https://github.com/settings/personal-access-tokens' }
  if (report.source !== 'app') return {}
  const out: Pick<GitHubStatus, 'appUrl' | 'permissionsUrl' | 'installUrl'> = {}
  if (report.appSlug) {
    const base = report.appOwner?.type === 'Organization' ? `https://github.com/organizations/${report.appOwner.login}/settings/apps/${report.appSlug}` : `https://github.com/settings/apps/${report.appSlug}`
    out.appUrl = base
    out.permissionsUrl = `${base}/permissions`
  }
  if (report.installationId) {
    out.installUrl =
      report.accountType === 'Organization' && report.account
        ? `https://github.com/organizations/${report.account}/settings/installations/${report.installationId}`
        : `https://github.com/settings/installations/${report.installationId}`
  }
  return out
}

/** A status for a source that could not be asked: every row unknown, nothing missing, the error kept for the operator. */
export function unknownStatus(source: GitHubAuthKind, error: string | undefined, webhookUrl: string | undefined): GitHubStatus {
  return {
    ok: false,
    source,
    webhookUrl,
    ...githubLinks({ source, granted: {} }),
    permissions: requiredFor(source).map((p) => ({ ...p, granted: 'unknown' as const, ok: null })),
    missing: [],
    checkedAt: new Date().toISOString(),
    error,
  }
}

export function buildStatus(report: PermissionReport, webhookUrl: string | undefined): GitHubStatus {
  const { permissions, missing } = evaluate(report)
  return {
    ok: report.source !== 'none' && missing.length === 0,
    source: report.source,
    account: report.account,
    installationId: report.installationId,
    repoCount: report.repoCount,
    appSlug: report.appSlug,
    ...githubLinks(report),
    webhookUrl,
    note: report.note,
    permissions,
    missing,
    checkedAt: new Date().toISOString(),
  }
}

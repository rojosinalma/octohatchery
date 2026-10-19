export const SELF_HOSTED = 'self-hosted'

export type LabelTarget = { type: string; typeLabels: string[]; host: string; knownHosts: string[] }

/**
 * A job matches a (type, host) when every job label is one of
 * `self-hosted`, the type name, this host or the type's extra labels,
 * it names the type explicitly, and any host it names is this host.
 */
export function matchesLabels(jobLabels: string[], target: LabelTarget): boolean {
  const labels = jobLabels.map((l) => l.toLowerCase())
  if (!labels.includes(SELF_HOSTED)) return false
  if (!labels.includes(target.type.toLowerCase())) return false
  const allowed = new Set([SELF_HOSTED, target.type, target.host, ...target.typeLabels].map((l) => l.toLowerCase()))
  const hosts = new Set(target.knownHosts.map((h) => h.toLowerCase()))
  for (const l of labels) {
    if (hosts.has(l) && l !== target.host.toLowerCase()) return false
    if (!allowed.has(l)) return false
  }
  return true
}

/** The labels a runner of `type` on `host` registers with. */
export function runnerLabels(type: string, host: string, extra: string[] = []): string[] {
  return [...new Set([SELF_HOSTED, type, host, ...extra])]
}

/** `runs-on` value for a type, optionally pinned to a host. */
export function runsOnLabels(type: string, host?: string): string[] {
  return host ? [SELF_HOSTED, type, host] : [SELF_HOSTED, type]
}

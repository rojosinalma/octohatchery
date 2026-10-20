export type Host = {
  id: number
  name: string
  status: 'online' | 'offline'
  lastSeenAt: string
  isLeader: boolean
  dockerOk: boolean
  /** Reported by the node's heartbeat; null until the first report (older nodes never report them). */
  cpus: number | null
  memoryMb: number | null
  os: string | null
  dockerVersion: string | null
  appVersion: string | null
}
export type HostSpecs = Pick<Host, 'cpus' | 'memoryMb' | 'os' | 'dockerVersion' | 'appVersion'>
export type RunnerType = {
  id: number
  name: string
  description: string | null
  labels: string[]
  image: string
  cpus: number
  memoryMb: number
  mounts: string[]
  env: Record<string, string>
  secretEnv: string[]
  createdAt: string
  updatedAt: string
}
export type Slot = { host: string; type: string; count: number; used: number; free: number }
export type Repo = { id: number; fullName: string; adopted: boolean; isPrivate: boolean; webhookId: number | null; adoptedAt: string | null }
/** A repo as listed: with the number of job rows it has in the retention window. */
export type RepoListItem = Repo & { jobCount: number }
/** Outcome of `ensureWebhook`: a repo hook was created or repaired, or the GitHub App delivers the events. */
export type WebhookOutcome = { repo: Repo; covered: 'hook' | 'app'; created: boolean }
export type JobStatus = 'queued' | 'claimed' | 'in_progress' | 'completed' | 'ignored'
export type Job = {
  id: number
  repo: string
  githubJobId: number
  runId: number
  name: string
  labels: string[]
  status: JobStatus
  conclusion: string | null
  runnerId: number | null
  htmlUrl: string
  queuedAt: string
  startedAt: string | null
  completedAt: string | null
  /** Where the stored log came from: `runner` (container stdout), `github` (final log) or null while it is still being collected. */
  logSource: LogSource
  logBytes: number
  logTruncated: boolean
}
export type LogSource = 'runner' | 'github' | null
export type LogLine = { seq: number; at: string; line: string }
export type JobLog = { lines: LogLine[]; source: LogSource; truncated: boolean; complete: boolean }
export type RunnerState = 'spawning' | 'idle' | 'busy' | 'exited' | 'failed' | 'removed'
export type Runner = {
  id: number
  name: string
  host: string
  type: string
  containerId: string | null
  state: RunnerState
  jobId: number | null
  repo: string | null
  jobName: string | null
  createdAt: string
  exitedAt: string | null
}
export type Event = { id: number; actor: string; action: string; target: string; detail: Record<string, unknown>; at: string }
export type HealthSnapshot = {
  ok: boolean
  mode: 'single' | 'cluster'
  host: string
  db: boolean
  docker: boolean
  leader: boolean
  slots: Slot[]
  queued: number
  runnersBusy: number
  lastWebhookAt: string | null
  version: string
}
export type Actor = string // 'user' | 'mcp:<client>' | 'webhook' | 'scheduler' | 'sweep'
export type RunsOnMode = 'snippet' | 'pr' | 'commit'
export type ApplyRunsOnResult = { ok: boolean; message: string; snippet?: string; prUrl?: string; commitSha?: string; files?: string[] }

export class ServiceError extends Error {
  constructor(
    message: string,
    public code: 'not_found' | 'invalid' | 'conflict' | 'unavailable' = 'invalid',
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}

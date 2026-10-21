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
/** Docker access a runner gets: none, the host's daemon over its socket, or a private daemon sidecar per runner. */
export type RunnerDocker = 'none' | 'socket' | 'dind'
/** Page sizes `listJobs` and `GET /api/jobs` accept for `per`; anything else is rejected at the boundary. */
export const JOBS_PER_PAGE = [10, 20, 25, 50, 100] as const
export const JOBS_PER_MAX = 100

export const RUNNER_DOCKER_OPTIONS: readonly RunnerDocker[] = ['none', 'socket', 'dind']
/** User a runner container runs as: the one its image declares (the shipped image: `runner`, uid 1001) or root (uid 0). */
export type RunnerRunAs = 'image' | 'root'
export const RUNNER_RUN_AS_OPTIONS: readonly RunnerRunAs[] = ['image', 'root']
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
  docker: RunnerDocker
  runAs: RunnerRunAs
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
/** One workflow step as GitHub reports it (`workflow_job.steps[]`); timestamps are ISO strings or null until known. */
export type JobStep = {
  number: number
  name: string
  status: 'queued' | 'in_progress' | 'completed' | string
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | string | null
  startedAt: string | null
  completedAt: string | null
}
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
  /** Steps as last reported by GitHub (webhook payload or the job API); empty until the job starts. */
  steps: JobStep[]
  /** Check-run annotations GitHub reported for the job once it ended (errors, warnings, notices); empty otherwise. */
  annotations: JobAnnotation[]
}
/** One check-run annotation: `failure` = error, `warning`, `notice`; `path`/`line` point into the repo when GitHub knows them. */
export type JobAnnotation = { level: 'failure' | 'warning' | 'notice'; message: string; title: string | null; path: string | null; startLine: number | null; endLine: number | null }
export type LogSource = 'runner' | 'github' | null
/** One stored log line; `step` is reserved for a per-step log source and absent today (`job_logs.step` stays null). */
export type LogLine = { seq: number; at: string; line: string; step?: number | null }
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
/** An image present on a host's engine, as last seen by that node's heartbeat. */
export type HostImage = { host: string; reference: string; digest: string | null; sizeBytes: number | null; pulledAt: string | null; seenAt: string }
export type ImagePullStatus = 'queued' | 'running' | 'done' | 'failed'
export const IMAGE_PULL_ACTIVE: readonly ImagePullStatus[] = ['queued', 'running']
/** A pull request for one image on one host; the node that owns the host runs it. */
export type ImagePull = { id: number; host: string; reference: string; status: ImagePullStatus; error: string | null; requestedBy: string; createdAt: string; finishedAt: string | null }
/** The whole image picture: every reference the orchestrator wants, what each host has, and the latest pull per cell. */
export type ImageInventory = { references: string[]; hosts: Host[]; images: HostImage[]; pulls: ImagePull[] }
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
  /** GitHub credentials check (cached): a missing permission is a warning, never a 503. */
  github: { ok: boolean; source: 'app' | 'pat' | 'none'; missing: string[] }
}
export type Actor = string // 'user' | 'mcp:<client>' | 'webhook' | 'scheduler' | 'sweep'
export type RunsOnMode = 'snippet' | 'pr' | 'commit'
export type ApplyRunsOnResult = { ok: boolean; message: string; snippet?: string; prUrl?: string; commitSha?: string; htmlUrl?: string; files?: string[] }
/** A repository the credentials can reach, with whether this instance already adopted it. */
export type GitHubRepoItem = { fullName: string; isPrivate: boolean; defaultBranch: string; adopted: boolean }

export class ServiceError extends Error {
  constructor(
    message: string,
    public code: 'not_found' | 'invalid' | 'conflict' | 'unavailable' = 'invalid',
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}

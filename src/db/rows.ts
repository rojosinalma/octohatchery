import { RUNNER_DOCKER_OPTIONS, RUNNER_RUN_AS_OPTIONS, type Event, type Host, type HostImage, type ImagePull, type ImagePullStatus, type Job, type JobStatus, type JobAnnotation, type JobStep, type LogLine, type Repo, type Runner, type RunnerDocker, type RunnerRunAs, type RunnerState, type RunnerType } from '../lib/types'
import type { Row } from './driver'

// Row → domain mappers. SQLite returns booleans as 0/1 and JSON as text; Postgres returns booleans natively.

export function bool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 't'
}

export function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v)
}

export function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v)
}

export function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}

export function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v)
}

export function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string') return (v as T) ?? fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

export function toHost(r: Row): Host {
  return {
    id: num(r.id),
    name: str(r.name),
    status: r.status === 'offline' ? 'offline' : 'online',
    lastSeenAt: str(r.last_seen_at),
    isLeader: bool(r.is_leader),
    dockerOk: bool(r.docker_ok),
    cpus: numOrNull(r.cpus),
    memoryMb: numOrNull(r.memory_mb),
    os: strOrNull(r.os),
    dockerVersion: strOrNull(r.docker_version),
    appVersion: strOrNull(r.app_version),
  }
}

export function toRunnerType(r: Row): RunnerType {
  return {
    id: num(r.id),
    name: str(r.name),
    description: strOrNull(r.description),
    labels: json<string[]>(r.labels, []),
    image: str(r.image),
    cpus: num(r.cpus),
    memoryMb: num(r.memory_mb),
    mounts: json<string[]>(r.mounts, []),
    env: json<Record<string, string>>(r.env, {}),
    secretEnv: json<string[]>(r.secret_env, []),
    docker: (RUNNER_DOCKER_OPTIONS as readonly string[]).includes(str(r.docker)) ? (str(r.docker) as RunnerDocker) : 'none',
    runAs: (RUNNER_RUN_AS_OPTIONS as readonly string[]).includes(str(r.run_as)) ? (str(r.run_as) as RunnerRunAs) : 'image',
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  }
}

export function toRepo(r: Row): Repo {
  return {
    id: num(r.id),
    fullName: str(r.full_name),
    adopted: bool(r.adopted),
    isPrivate: bool(r.is_private),
    webhookId: numOrNull(r.webhook_id),
    adoptedAt: strOrNull(r.adopted_at),
  }
}

export function toJob(r: Row): Job & { retries: number } {
  return {
    id: num(r.id),
    repo: str(r.repo),
    githubJobId: num(r.github_job_id),
    runId: num(r.run_id),
    name: str(r.name),
    labels: json<string[]>(r.labels, []),
    status: str(r.status) as JobStatus,
    conclusion: strOrNull(r.conclusion),
    runnerId: numOrNull(r.runner_id),
    htmlUrl: str(r.html_url),
    queuedAt: str(r.queued_at),
    startedAt: strOrNull(r.started_at),
    completedAt: strOrNull(r.completed_at),
    retries: num(r.retries ?? 0),
    logSource: r.log_source === 'runner' || r.log_source === 'github' ? r.log_source : null,
    logBytes: num(r.log_bytes ?? 0),
    logTruncated: bool(r.log_truncated),
    steps: json<JobStep[]>(r.steps, []).filter((s) => s && typeof s === 'object'),
    annotations: json<JobAnnotation[]>(r.annotations, []).filter((a) => a && typeof a === 'object'),
  }
}

export function toLogLine(r: Row): LogLine {
  const out: LogLine = { seq: num(r.seq), at: str(r.at), line: str(r.line) }
  const step = numOrNull(r.step)
  if (step !== null) out.step = step
  return out
}

export function toRunner(r: Row): Runner & { githubRunnerId: number | null } {
  return {
    id: num(r.id),
    name: str(r.name),
    host: str(r.host),
    type: str(r.type),
    containerId: strOrNull(r.container_id),
    state: str(r.state) as RunnerState,
    jobId: numOrNull(r.job_id),
    repo: strOrNull(r.repo),
    jobName: strOrNull(r.job_name),
    githubRunnerId: numOrNull(r.github_runner_id),
    createdAt: str(r.created_at),
    exitedAt: strOrNull(r.exited_at),
  }
}

export function toEvent(r: Row): Event {
  return {
    id: num(r.id),
    actor: str(r.actor),
    action: str(r.action),
    target: str(r.target),
    detail: json<Record<string, unknown>>(r.detail, {}),
    at: str(r.at),
  }
}

/** Joined with `hosts` for the name: `select i.*, h.name as host …`. */
export function toHostImage(r: Row): HostImage {
  return {
    host: str(r.host),
    reference: str(r.reference),
    digest: strOrNull(r.digest),
    sizeBytes: numOrNull(r.size_bytes),
    pulledAt: strOrNull(r.pulled_at),
    seenAt: str(r.seen_at),
  }
}

export function toImagePull(r: Row): ImagePull {
  return {
    id: num(r.id),
    host: str(r.host),
    reference: str(r.reference),
    status: str(r.status) as ImagePullStatus,
    error: strOrNull(r.error),
    requestedBy: str(r.requested_by),
    createdAt: str(r.created_at),
    finishedAt: strOrNull(r.finished_at),
  }
}

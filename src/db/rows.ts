import { RUNNER_DOCKER_OPTIONS, type Event, type Host, type Job, type JobStatus, type LogLine, type Repo, type Runner, type RunnerDocker, type RunnerState, type RunnerType } from '../lib/types'
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
  }
}

export function toLogLine(r: Row): LogLine {
  return { seq: num(r.seq), at: str(r.at), line: str(r.line) }
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

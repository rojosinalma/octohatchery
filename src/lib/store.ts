import { sql, type SQL } from 'drizzle-orm'
import { db, type Db } from '../db'
import { toHost, toJob, toLogLine, toRepo, toRunner, toRunnerType } from '../db/rows'
import { bus } from './bus'
import type { Host, Job, JobStatus, LogLine, Repo, Runner, RunnerState, RunnerType, Slot } from './types'

// Shared queries used by the service, scheduler, sweep and webhook handlers.

export const ACTIVE_RUNNER_STATES: readonly RunnerState[] = ['spawning', 'idle', 'busy']

export function now(): string {
  return new Date().toISOString()
}

function inList(values: readonly string[]): SQL {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )
}

// hosts

export async function listHosts(d: Db = db()): Promise<Host[]> {
  return (await d.all(sql`select * from hosts order by name`)).map(toHost)
}

export async function hostByName(name: string, d: Db = db()): Promise<Host | undefined> {
  const [row] = await d.all(sql`select * from hosts where name = ${name}`)
  return row ? toHost(row) : undefined
}

export async function upsertHost(input: { name: string; isLeader: boolean; dockerOk: boolean }, d: Db = db()): Promise<Host> {
  const [row] = await d.all(sql`
    insert into hosts (name, status, last_seen_at, is_leader, docker_ok)
    values (${input.name}, 'online', ${now()}, ${input.isLeader}, ${input.dockerOk})
    on conflict (name) do update set status = 'online', last_seen_at = excluded.last_seen_at,
      is_leader = excluded.is_leader, docker_ok = excluded.docker_ok
    returning *`)
  return toHost(row!)
}

// runner types

export async function listRunnerTypes(d: Db = db()): Promise<RunnerType[]> {
  return (await d.all(sql`select * from runner_types order by name`)).map(toRunnerType)
}

export async function runnerTypeByName(name: string, d: Db = db()): Promise<RunnerType | undefined> {
  const [row] = await d.all(sql`select * from runner_types where name = ${name}`)
  return row ? toRunnerType(row) : undefined
}

// slots

/** Configured slots joined with live usage (active runners per host/type). */
export async function slotsView(d: Db = db()): Promise<Slot[]> {
  const rows = await d.all<{ host: string; type: string; count: number | string; used: number | string }>(sql`
    select h.name as host, t.name as type, s.count as count,
      (select count(*) from runners r where r.host = h.name and r.type = t.name and r.state in (${inList(ACTIVE_RUNNER_STATES)})) as used
    from slots s
    join hosts h on h.id = s.host_id
    join runner_types t on t.id = s.runner_type_id
    order by h.name, t.name`)
  return rows.map((r) => {
    const count = Number(r.count)
    const used = Number(r.used)
    return { host: r.host, type: r.type, count, used, free: Math.max(0, count - used) }
  })
}

// repos

export async function listRepos(d: Db = db()): Promise<Repo[]> {
  return (await d.all(sql`select * from repos order by full_name`)).map(toRepo)
}

export async function repoByName(fullName: string, d: Db = db()): Promise<Repo | undefined> {
  const [row] = await d.all(sql`select * from repos where full_name = ${fullName}`)
  return row ? toRepo(row) : undefined
}

export async function adoptedRepos(d: Db = db()): Promise<Repo[]> {
  return (await d.all(sql`select * from repos where adopted = true order by full_name`)).map(toRepo)
}

// jobs

export type JobRow = Job & { retries: number }

export async function jobById(id: number, d: Db = db()): Promise<JobRow | undefined> {
  const [row] = await d.all(sql`select * from jobs where id = ${id}`)
  return row ? toJob(row) : undefined
}

export async function jobByGitHubId(githubJobId: number, d: Db = db()): Promise<JobRow | undefined> {
  const [row] = await d.all(sql`select * from jobs where github_job_id = ${githubJobId}`)
  return row ? toJob(row) : undefined
}

export type NewJob = { repo: string; githubJobId: number; runId: number; name: string; labels: string[]; htmlUrl: string; queuedAt: string; status: JobStatus }

/** Inserts a job if its GitHub id is new; existing rows are left untouched (webhook and poll may both see it). */
export async function insertJobIfNew(j: NewJob, d: Db = db()): Promise<JobRow | undefined> {
  const [row] = await d.all(sql`
    insert into jobs (repo, github_job_id, run_id, name, labels, status, html_url, queued_at)
    values (${j.repo}, ${j.githubJobId}, ${j.runId}, ${j.name}, ${JSON.stringify(j.labels)}, ${j.status}, ${j.htmlUrl}, ${j.queuedAt})
    on conflict (github_job_id) do nothing
    returning *`)
  if (!row) return undefined
  const job = toJob(row)
  bus.emit('job', job)
  return job
}

export type JobPatch = Partial<Pick<JobRow, 'status' | 'conclusion' | 'runnerId' | 'startedAt' | 'completedAt' | 'retries' | 'logSource' | 'logBytes' | 'logTruncated'>>

/** `silent` skips the bus notification (log bookkeeping that changes nothing a dashboard table shows). */
export async function updateJob(id: number, patch: JobPatch, d: Db = db(), opts: { silent?: boolean } = {}): Promise<JobRow | undefined> {
  const sets: SQL[] = []
  if (patch.status !== undefined) sets.push(sql`status = ${patch.status}`)
  if (patch.conclusion !== undefined) sets.push(sql`conclusion = ${patch.conclusion}`)
  if (patch.runnerId !== undefined) sets.push(sql`runner_id = ${patch.runnerId}`)
  if (patch.startedAt !== undefined) sets.push(sql`started_at = ${patch.startedAt}`)
  if (patch.completedAt !== undefined) sets.push(sql`completed_at = ${patch.completedAt}`)
  if (patch.retries !== undefined) sets.push(sql`retries = ${patch.retries}`)
  if (patch.logSource !== undefined) sets.push(sql`log_source = ${patch.logSource}`)
  if (patch.logBytes !== undefined) sets.push(sql`log_bytes = ${patch.logBytes}`)
  if (patch.logTruncated !== undefined) sets.push(sql`log_truncated = ${patch.logTruncated}`)
  if (!sets.length) return jobById(id, d)
  const [row] = await d.all(sql`update jobs set ${sql.join(sets, sql`, `)} where id = ${id} returning *`)
  if (!row) return undefined
  const job = toJob(row)
  if (!opts.silent) bus.emit('job', job)
  return job
}

// job logs

/** Lines after `after` (exclusive) in order, at most `limit`. */
export async function logLinesAfter(jobId: number, after: number, limit: number, d: Db = db()): Promise<LogLine[]> {
  const rows = await d.all(sql`select seq, at, line from job_logs where job_id = ${jobId} and seq > ${after} order by seq limit ${limit}`)
  return rows.map(toLogLine)
}

/** The last `n` lines in order. */
export async function logTail(jobId: number, n: number, d: Db = db()): Promise<LogLine[]> {
  const rows = await d.all(sql`select seq, at, line from job_logs where job_id = ${jobId} order by seq desc limit ${n}`)
  return rows.map(toLogLine).reverse()
}

/** Highest stored seq and its timestamp, or `{ seq: 0, at: null }` when nothing is stored. */
export async function logCursor(jobId: number, d: Db = db()): Promise<{ seq: number; at: string | null }> {
  const [row] = await d.all<{ seq: unknown; at: unknown }>(sql`select seq, at from job_logs where job_id = ${jobId} order by seq desc limit 1`)
  return row ? { seq: Number(row.seq), at: String(row.at) } : { seq: 0, at: null }
}

/** Appends lines with consecutive seqs starting at `fromSeq`; one statement per batch. */
export async function appendLogLines(jobId: number, fromSeq: number, lines: { at: string; line: string }[], d: Db = db()): Promise<LogLine[]> {
  if (!lines.length) return []
  const out = lines.map((l, i) => ({ seq: fromSeq + i, at: l.at, line: l.line }))
  await d.run(sql`insert into job_logs (job_id, seq, at, line) values ${sql.join(
    out.map((l) => sql`(${jobId}, ${l.seq}, ${l.at}, ${l.line})`),
    sql`, `,
  )}`)
  return out
}

export async function deleteLogLines(jobId: number, d: Db = db()): Promise<void> {
  await d.run(sql`delete from job_logs where job_id = ${jobId}`)
}

// runners

export type RunnerRow = Runner & { githubRunnerId: number | null }

export async function runnerById(id: number, d: Db = db()): Promise<RunnerRow | undefined> {
  const [row] = await d.all(sql`select * from runners where id = ${id}`)
  return row ? toRunner(row) : undefined
}

export async function activeRunners(host?: string, d: Db = db()): Promise<RunnerRow[]> {
  const where = host ? sql`where host = ${host} and state in (${inList(ACTIVE_RUNNER_STATES)})` : sql`where state in (${inList(ACTIVE_RUNNER_STATES)})`
  return (await d.all(sql`select * from runners ${where} order by id`)).map(toRunner)
}

export async function insertRunner(input: { name: string; host: string; type: string; jobId: number | null; repo: string | null; jobName: string | null }, d: Db = db()): Promise<RunnerRow> {
  const [row] = await d.all(sql`
    insert into runners (name, host, type, state, job_id, repo, job_name, created_at)
    values (${input.name}, ${input.host}, ${input.type}, 'spawning', ${input.jobId}, ${input.repo}, ${input.jobName}, ${now()})
    returning *`)
  const runner = toRunner(row!)
  bus.emit('runner', runner)
  return runner
}

export type RunnerPatch = Partial<Pick<RunnerRow, 'state' | 'containerId' | 'jobId' | 'repo' | 'jobName' | 'githubRunnerId' | 'exitedAt'>>

export async function updateRunner(id: number, patch: RunnerPatch, d: Db = db()): Promise<RunnerRow | undefined> {
  const sets: SQL[] = []
  if (patch.state !== undefined) sets.push(sql`state = ${patch.state}`)
  if (patch.containerId !== undefined) sets.push(sql`container_id = ${patch.containerId}`)
  if (patch.jobId !== undefined) sets.push(sql`job_id = ${patch.jobId}`)
  if (patch.repo !== undefined) sets.push(sql`repo = ${patch.repo}`)
  if (patch.jobName !== undefined) sets.push(sql`job_name = ${patch.jobName}`)
  if (patch.githubRunnerId !== undefined) sets.push(sql`github_runner_id = ${patch.githubRunnerId}`)
  if (patch.exitedAt !== undefined) sets.push(sql`exited_at = ${patch.exitedAt}`)
  if (!sets.length) return runnerById(id, d)
  const [row] = await d.all(sql`update runners set ${sql.join(sets, sql`, `)} where id = ${id} returning *`)
  if (!row) return undefined
  const runner = toRunner(row)
  bus.emit('runner', runner)
  bus.emit('slot', { host: runner.host, type: runner.type })
  return runner
}

export async function countJobs(status: JobStatus, d: Db = db()): Promise<number> {
  const [row] = await d.all<{ n: number | string }>(sql`select count(*) as n from jobs where status = ${status}`)
  return Number(row?.n ?? 0)
}

export async function countRunners(state: RunnerState, d: Db = db()): Promise<number> {
  const [row] = await d.all<{ n: number | string }>(sql`select count(*) as n from runners where state = ${state}`)
  return Number(row?.n ?? 0)
}

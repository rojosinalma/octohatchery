import { sql, type SQL } from 'drizzle-orm'
import { db, type Db } from '../db'
import { toHost, toHostImage, toImagePull, toJob, toLogLine, toRepo, toRunner, toRunnerType } from '../db/rows'
import type { ImageInfo } from './backends/types'
import { bus } from './bus'
import { IMAGE_PULL_ACTIVE, type Host, type HostImage, type HostSpecs, type ImagePull, type Job, type JobStatus, type LogLine, type Repo, type RepoListItem, type Runner, type RunnerState, type RunnerType, type Slot } from './types'

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

/** Heartbeat upsert. `specs` is optional: a node that cannot read them keeps what the row already has. */
export async function upsertHost(input: { name: string; isLeader: boolean; dockerOk: boolean; specs?: Partial<HostSpecs> }, d: Db = db()): Promise<Host> {
  const s = input.specs ?? {}
  const [row] = await d.all(sql`
    insert into hosts (name, status, last_seen_at, is_leader, docker_ok, cpus, memory_mb, os, docker_version, app_version)
    values (${input.name}, 'online', ${now()}, ${input.isLeader}, ${input.dockerOk},
      ${s.cpus ?? null}, ${s.memoryMb ?? null}, ${s.os ?? null}, ${s.dockerVersion ?? null}, ${s.appVersion ?? null})
    on conflict (name) do update set status = 'online', last_seen_at = excluded.last_seen_at,
      is_leader = excluded.is_leader, docker_ok = excluded.docker_ok,
      cpus = coalesce(excluded.cpus, hosts.cpus), memory_mb = coalesce(excluded.memory_mb, hosts.memory_mb),
      os = coalesce(excluded.os, hosts.os), docker_version = coalesce(excluded.docker_version, hosts.docker_version),
      app_version = coalesce(excluded.app_version, hosts.app_version)
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

/** Every repo with its job-row count, in one query (a correlated count, not one query per repo). */
export async function listRepos(d: Db = db()): Promise<RepoListItem[]> {
  const rows = await d.all(sql`
    select r.*, (select count(*) from jobs j where j.repo = r.full_name) as job_count
    from repos r order by r.full_name`)
  return rows.map((r) => ({ ...toRepo(r), jobCount: Number(r.job_count ?? 0) }))
}

export async function setRepoWebhook(fullName: string, webhookId: number | null, d: Db = db()): Promise<Repo | undefined> {
  const [row] = await d.all(sql`update repos set webhook_id = ${webhookId} where full_name = ${fullName} returning *`)
  return row ? toRepo(row) : undefined
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

export type JobPatch = Partial<Pick<JobRow, 'status' | 'conclusion' | 'runnerId' | 'startedAt' | 'completedAt' | 'retries' | 'logSource' | 'logBytes' | 'logTruncated' | 'steps' | 'annotations'>>

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
  if (patch.steps !== undefined) sets.push(sql`steps = ${JSON.stringify(patch.steps)}`)
  if (patch.annotations !== undefined) sets.push(sql`annotations = ${JSON.stringify(patch.annotations)}`)
  if (!sets.length) return jobById(id, d)
  const [row] = await d.all(sql`update jobs set ${sql.join(sets, sql`, `)} where id = ${id} returning *`)
  if (!row) return undefined
  const job = toJob(row)
  if (!opts.silent) bus.emit('job', job)
  return job
}

/**
 * Completed jobs whose final log is stored but whose `steps` are still empty, oldest first. Jobs that ended without
 * a runner here never get a GitHub log, so they are left alone; a job GitHub reports no steps for is retried each
 * pass until the retention purge takes it (bounded by `limit`).
 */
export async function jobsWithoutSteps(limit: number, d: Db = db()): Promise<JobRow[]> {
  const rows = await d.all(sql`select * from jobs where status = 'completed' and log_source = 'github' and steps = '[]' order by completed_at desc limit ${limit}`)
  return rows.map(toJob)
}

/**
 * Completed jobs (ended at or after `since`) with a stored GitHub log none of whose lines carries a step number yet
 * (rows from before per-step logs, or whose archive was not available), newest first.
 */
export async function jobsWithoutStepLines(limit: number, since: string, d: Db = db()): Promise<JobRow[]> {
  const rows = await d.all(sql`select * from jobs j where status = 'completed' and log_source = 'github' and completed_at >= ${since}
    and exists (select 1 from job_logs l where l.job_id = j.id)
    and not exists (select 1 from job_logs l where l.job_id = j.id and l.step is not null)
    order by completed_at desc limit ${limit}`)
  return rows.map(toJob)
}

// job logs

/** Lines after `after` (exclusive) in order, at most `limit`. */
export async function logLinesAfter(jobId: number, after: number, limit: number, d: Db = db()): Promise<LogLine[]> {
  const rows = await d.all(sql`select seq, at, line, step from job_logs where job_id = ${jobId} and seq > ${after} order by seq limit ${limit}`)
  return rows.map(toLogLine)
}

/** The last `n` lines in order. */
export async function logTail(jobId: number, n: number, d: Db = db()): Promise<LogLine[]> {
  const rows = await d.all(sql`select seq, at, line, step from job_logs where job_id = ${jobId} order by seq desc limit ${n}`)
  return rows.map(toLogLine).reverse()
}

/** Highest stored seq and its timestamp, or `{ seq: 0, at: null }` when nothing is stored. */
export async function logCursor(jobId: number, d: Db = db()): Promise<{ seq: number; at: string | null }> {
  const [row] = await d.all<{ seq: unknown; at: unknown }>(sql`select seq, at from job_logs where job_id = ${jobId} order by seq desc limit 1`)
  return row ? { seq: Number(row.seq), at: String(row.at) } : { seq: 0, at: null }
}

/** Appends lines with consecutive seqs starting at `fromSeq`; one statement per batch. A line's `step` is kept when set. */
export async function appendLogLines(jobId: number, fromSeq: number, lines: { at: string; line: string; step?: number | null }[], d: Db = db()): Promise<LogLine[]> {
  if (!lines.length) return []
  const out: LogLine[] = lines.map((l, i) => (l.step == null ? { seq: fromSeq + i, at: l.at, line: l.line } : { seq: fromSeq + i, at: l.at, line: l.line, step: l.step }))
  await d.run(sql`insert into job_logs (job_id, seq, at, line, step) values ${sql.join(
    out.map((l) => sql`(${jobId}, ${l.seq}, ${l.at}, ${l.line}, ${l.step ?? null})`),
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

/** The newest runner with this name (names carry a timestamp and a random suffix, so in practice one row). */
export async function runnerByName(name: string, d: Db = db()): Promise<RunnerRow | undefined> {
  const [row] = await d.all(sql`select * from runners where name = ${name} order by id desc limit 1`)
  return row ? toRunner(row) : undefined
}

/**
 * The container is up: store its ids and move `spawning` to `idle`. A runner that a webhook already marked `busy`
 * (GitHub can hand it a job before the spawn call returns) or that was killed meanwhile keeps its state.
 */
export async function markRunnerStarted(id: number, patch: { containerId: string; githubRunnerId: number; repo: string }, d: Db = db()): Promise<RunnerRow | undefined> {
  const [row] = await d.all(sql`
    update runners set state = case when state = 'spawning' then 'idle' else state end,
      container_id = ${patch.containerId}, github_runner_id = ${patch.githubRunnerId}, repo = ${patch.repo}
    where id = ${id} returning *`)
  if (!row) return undefined
  const runner = toRunner(row)
  bus.emit('runner', runner)
  bus.emit('slot', { host: runner.host, type: runner.type })
  return runner
}

/** Serialises rebinds across nodes (two webhooks naming each other's runners would otherwise deadlock on row locks). */
const REBIND_LOCK_KEY = 'octohatchery:rebind'
/** Temporary seq offset while two jobs swap their live lines (job_logs is keyed by job and seq). */
const SWAP_SEQ_OFFSET = 1_000_000_000

export type Rebind = { job: JobRow; runner: RunnerRow; previousRunnerId: number | null; displacedJobId: number | null }

/**
 * A JIT runner is registered with labels, not with a job: GitHub gives it any queued job of the repo that matches,
 * so the runner a job was claimed for is not always the one that runs it. When GitHub names the runner, the
 * binding follows: the job moves to that runner, and the job that runner was claimed for moves to the job's old
 * runner (or back to `queued` when there is none). Live log lines move with their runner. Returns undefined when
 * the binding already matches or the runner is not ours.
 */
export async function rebindJob(jobId: number, runnerName: string, d: Db = db()): Promise<Rebind | undefined> {
  return d.transaction(async (tx) => {
    if (tx.dialect === 'postgres') await tx.run(sql`select pg_advisory_xact_lock(hashtext(${REBIND_LOCK_KEY}))`)
    const job = await jobById(jobId, tx)
    const runner = await runnerByName(runnerName, tx)
    if (!job || !runner || job.runnerId === runner.id || (runner.repo !== null && runner.repo !== job.repo)) return undefined
    const previous = job.runnerId === null ? undefined : await runnerById(job.runnerId, tx)
    const [displacedRow] = runner.jobId === null || runner.jobId === job.id ? [] : await tx.all(sql`select * from jobs where id = ${runner.jobId}`)
    const displaced = displacedRow ? toJob(displacedRow) : undefined
    const takeover = previous && (previous.state === 'spawning' || previous.state === 'idle' || previous.state === 'busy') ? previous : undefined

    // Live lines: the job's current lines came from its old runner, the displaced job's from this runner.
    await tx.run(sql`update job_logs set seq = seq + ${SWAP_SEQ_OFFSET} where job_id = ${job.id}`)
    if (displaced) await tx.run(sql`update job_logs set job_id = ${job.id} where job_id = ${displaced.id}`)
    if (displaced && takeover) {
      await tx.run(sql`update job_logs set job_id = ${displaced.id}, seq = seq - ${SWAP_SEQ_OFFSET} where job_id = ${job.id} and seq > ${SWAP_SEQ_OFFSET}`)
      await updateJob(displaced.id, { runnerId: takeover.id, logBytes: job.logBytes, logTruncated: job.logTruncated }, tx)
    } else {
      await tx.run(sql`delete from job_logs where job_id = ${job.id} and seq > ${SWAP_SEQ_OFFSET}`)
      // Nobody is left to run it: back to the queue so the scheduler spawns a runner for it.
      if (displaced) await updateJob(displaced.id, { runnerId: null, logBytes: 0, logTruncated: false, ...(displaced.status === 'claimed' ? { status: 'queued' as const } : {}) }, tx)
    }
    if (previous) await updateRunner(previous.id, { jobId: takeover && displaced ? displaced.id : null, jobName: takeover && displaced ? displaced.name : null }, tx)
    const bound = await updateRunner(runner.id, { jobId: job.id, jobName: job.name }, tx)
    const rebound = await updateJob(job.id, { runnerId: runner.id, logBytes: displaced?.logBytes ?? 0, logTruncated: displaced?.logTruncated ?? false }, tx)
    return { job: rebound!, runner: bound!, previousRunnerId: previous?.id ?? null, displacedJobId: displaced?.id ?? null }
  })
}

export async function countJobs(status: JobStatus, d: Db = db()): Promise<number> {
  const [row] = await d.all<{ n: number | string }>(sql`select count(*) as n from jobs where status = ${status}`)
  return Number(row?.n ?? 0)
}

export async function countRunners(state: RunnerState, d: Db = db()): Promise<number> {
  const [row] = await d.all<{ n: number | string }>(sql`select count(*) as n from runners where state = ${state}`)
  return Number(row?.n ?? 0)
}

// host images

/** Every (host, reference) row joined with the host name, ordered for the matrix. */
export async function listHostImages(d: Db = db()): Promise<HostImage[]> {
  const rows = await d.all(sql`select i.*, h.name as host from host_images i join hosts h on h.id = i.host_id order by i.reference, h.name`)
  return rows.map(toHostImage)
}

/**
 * Replaces what the heartbeat knows about one host: `wanted` references that are present get upserted with the
 * engine's digest, size and creation time (`pulled_at`); rows for references no longer present (or no longer wanted)
 * are deleted. Returns true when the stored set changed, so the caller can announce it.
 */
export async function syncHostImages(hostName: string, present: ImageInfo[], wanted: readonly string[], d: Db = db()): Promise<boolean> {
  const host = await hostByName(hostName, d)
  if (!host) return false
  const before = (await d.all<{ reference: string; digest: unknown }>(sql`select reference, digest from host_images where host_id = ${host.id}`)).map((r) => `${r.reference}@${r.digest ?? ''}`).sort()
  const byRef = new Map(present.map((i) => [i.reference, i]))
  const keep = wanted.filter((ref) => byRef.has(ref))
  const seenAt = now()
  for (const ref of keep) {
    const i = byRef.get(ref)!
    await d.run(sql`
      insert into host_images (host_id, reference, digest, size_bytes, pulled_at, seen_at)
      values (${host.id}, ${ref}, ${i.digest}, ${i.sizeBytes}, ${i.createdAt}, ${seenAt})
      on conflict (host_id, reference) do update set digest = excluded.digest, size_bytes = excluded.size_bytes,
        pulled_at = excluded.pulled_at, seen_at = excluded.seen_at`)
  }
  if (keep.length) await d.run(sql`delete from host_images where host_id = ${host.id} and reference not in (${inList(keep)})`)
  else await d.run(sql`delete from host_images where host_id = ${host.id}`)
  const after = keep.map((ref) => `${ref}@${byRef.get(ref)!.digest ?? ''}`).sort()
  return before.join('\n') !== after.join('\n')
}

// image pulls

export async function insertImagePull(input: { hostId: number; reference: string; requestedBy: string }, d: Db = db()): Promise<ImagePull> {
  const [row] = await d.all(sql`
    insert into image_pulls (host_id, reference, status, requested_by, created_at)
    values (${input.hostId}, ${input.reference}, 'queued', ${input.requestedBy}, ${now()})
    returning *`)
  return (await imagePullById(num(row!.id), d))!
}

export async function imagePullById(id: number, d: Db = db()): Promise<ImagePull | undefined> {
  const [row] = await d.all(sql`select p.*, h.name as host from image_pulls p join hosts h on h.id = p.host_id where p.id = ${id}`)
  return row ? toImagePull(row) : undefined
}

/** A queued or running pull for this (host, reference), if any: a second request reuses it. */
export async function activeImagePull(hostId: number, reference: string, d: Db = db()): Promise<ImagePull | undefined> {
  const [row] = await d.all(sql`
    select p.*, h.name as host from image_pulls p join hosts h on h.id = p.host_id
    where p.host_id = ${hostId} and p.reference = ${reference} and p.status in (${inList(IMAGE_PULL_ACTIVE)}) order by p.id limit 1`)
  return row ? toImagePull(row) : undefined
}

/** The newest pull per (host, reference): the matrix shows a queued/running one as pulling and a failed one as the last error. */
export async function latestImagePulls(d: Db = db()): Promise<ImagePull[]> {
  const rows = await d.all(sql`
    select p.*, h.name as host from image_pulls p join hosts h on h.id = p.host_id
    where p.id in (select max(id) from image_pulls group by host_id, reference) order by p.reference, h.name`)
  return rows.map(toImagePull)
}

/** Marks the oldest queued pull for this host `running` and returns it; one at a time per node. */
export async function claimImagePull(hostName: string, d: Db = db()): Promise<ImagePull | undefined> {
  return d.transaction(async (tx) => {
    const host = await hostByName(hostName, tx)
    if (!host) return undefined
    const [running] = await tx.all(sql`select id from image_pulls where host_id = ${host.id} and status = 'running' limit 1`)
    if (running) return undefined
    const [next] = await tx.all(sql`select id from image_pulls where host_id = ${host.id} and status = 'queued' order by id limit 1`)
    if (!next) return undefined
    const [row] = await tx.all(sql`update image_pulls set status = 'running' where id = ${next.id} and status = 'queued' returning id`)
    return row ? imagePullById(num(row.id), tx) : undefined
  })
}

export async function finishImagePull(id: number, outcome: { status: 'done' | 'failed'; error?: string }, d: Db = db()): Promise<ImagePull | undefined> {
  await d.run(sql`update image_pulls set status = ${outcome.status}, error = ${outcome.error ?? null}, finished_at = ${now()} where id = ${id}`)
  return imagePullById(id, d)
}

/** Pulls left `running` by a node that died mid-pull are failed with a reason on its next start. */
export async function failStrandedImagePulls(hostName: string, reason: string, d: Db = db()): Promise<ImagePull[]> {
  const host = await hostByName(hostName, d)
  if (!host) return []
  const rows = await d.all(sql`update image_pulls set status = 'failed', error = ${reason}, finished_at = ${now()} where host_id = ${host.id} and status = 'running' returning id`)
  const out: ImagePull[] = []
  for (const r of rows) {
    const p = await imagePullById(num(r.id), d)
    if (p) out.push(p)
  }
  return out
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v)
}

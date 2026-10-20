import { sql } from 'drizzle-orm'
import pkg from '../../package.json'
import { db } from '../db'
import { toEvent, toJob, toRepo, toRunner, toRunnerType } from '../db/rows'
import { backend } from './backends'
import { config } from './config'
import { recordEvent } from './events'
import { github } from './github/auth'
import { SELF_HOSTED } from './labels'
import { log } from './log'
import { rewriteRunsOn, runsOnSnippet } from './runs-on'
import { FINALISE_GRACE_MS } from './joblog'
import { SETTING_DEFAULTS, settings } from './settings'
import { materialise } from './spawn'
import * as store from './store'
import { isLeader } from './sweep'
import { getLastWebhookAt } from './webhook'
import {
  ServiceError,
  type Actor,
  type ApplyRunsOnResult,
  type Event,
  type HealthSnapshot,
  type Host,
  type Job,
  type JobLog,
  type JobStatus,
  type Repo,
  type RepoListItem,
  type Runner,
  type RunnerState,
  type RunnerType,
  type RunsOnMode,
  type Slot,
  type WebhookOutcome,
} from './types'

const logger = log('service')

export type JobsFilter = { repo?: string; status?: JobStatus; q?: string; since?: string; running?: boolean; failed?: boolean; limit?: number }
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/
const MOUNT_RE = /^[^:]+:\/[^:]*(?::ro|:rw)?$/
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
const LOG_PAGE_LIMIT = 5000
const LOG_PAGE_MAX = 20_000
const LOG_LEVELS = ['debug', 'info', 'warn', 'error']

function limitOf(n: number | undefined): number {
  return Math.min(Math.max(1, n ?? DEFAULT_LIMIT), MAX_LIMIT)
}

function validateRunnerType(input: Omit<RunnerType, 'id' | 'createdAt' | 'updatedAt'>): void {
  if (!NAME_RE.test(input.name)) throw new ServiceError('runner type name must be lowercase letters, digits, "-" or "_" (max 63)')
  if (input.name === SELF_HOSTED) throw new ServiceError('"self-hosted" is reserved')
  if (!input.image.trim()) throw new ServiceError('image is required')
  if (!(input.cpus > 0)) throw new ServiceError('cpus must be greater than 0')
  if (!(input.memoryMb >= 128)) throw new ServiceError('memoryMb must be at least 128')
  for (const l of input.labels) if (!NAME_RE.test(l) || l === SELF_HOSTED) throw new ServiceError(`label "${l}" is not valid`)
  for (const m of input.mounts) if (!MOUNT_RE.test(m)) throw new ServiceError(`mount "${m}" must be "src:/dst[:ro]"`)
  for (const k of Object.keys(input.env)) if (!ENV_NAME_RE.test(k)) throw new ServiceError(`env name "${k}" is not valid`)
  for (const k of input.secretEnv) if (!ENV_NAME_RE.test(k)) throw new ServiceError(`secret env name "${k}" is not valid`)
}

async function requireHost(name: string): Promise<Host> {
  const host = await store.hostByName(name)
  if (!host) throw new ServiceError(`host "${name}" is unknown`, 'not_found')
  return host
}

async function requireType(name: string): Promise<RunnerType> {
  const type = await store.runnerTypeByName(name)
  if (!type) throw new ServiceError(`runner type "${name}" is unknown`, 'not_found')
  return type
}

async function requireJob(id: number): Promise<store.JobRow> {
  const job = await store.jobById(id)
  if (!job) throw new ServiceError(`job ${id} is unknown`, 'not_found')
  return job
}

/** No more lines can arrive: the final log is stored, or the job finished and its runner is gone past the finalise window. */
async function logComplete(job: Job): Promise<boolean> {
  if (job.logSource !== null) return true
  if (job.status !== 'completed' && job.status !== 'ignored') return false
  if (job.runnerId === null) return true
  const runner = await store.runnerById(job.runnerId)
  if (!runner) return true
  if (store.ACTIVE_RUNNER_STATES.includes(runner.state)) return false
  const endedAt = runner.exitedAt ?? job.completedAt
  return !endedAt || Date.now() - Date.parse(endedAt) > FINALISE_GRACE_MS
}

export const service = {
  async listHosts(): Promise<Host[]> {
    return store.listHosts()
  },

  async listRunnerTypes(): Promise<RunnerType[]> {
    return store.listRunnerTypes()
  },

  async getRunnerType(name: string): Promise<RunnerType> {
    return requireType(name)
  },

  async upsertRunnerType(input: Omit<RunnerType, 'id' | 'createdAt' | 'updatedAt'>, actor: Actor): Promise<RunnerType> {
    validateRunnerType(input)
    if (await store.hostByName(input.name)) throw new ServiceError(`"${input.name}" is a host name`, 'conflict')
    const now = store.now()
    const [row] = await db().all(sql`
      insert into runner_types (name, description, labels, image, cpus, memory_mb, mounts, env, secret_env, created_at, updated_at)
      values (${input.name}, ${input.description}, ${JSON.stringify(input.labels)}, ${input.image}, ${input.cpus}, ${input.memoryMb},
        ${JSON.stringify(input.mounts)}, ${JSON.stringify(input.env)}, ${JSON.stringify(input.secretEnv)}, ${now}, ${now})
      on conflict (name) do update set description = excluded.description, labels = excluded.labels, image = excluded.image,
        cpus = excluded.cpus, memory_mb = excluded.memory_mb, mounts = excluded.mounts, env = excluded.env,
        secret_env = excluded.secret_env, updated_at = excluded.updated_at
      returning *`)
    const type = toRunnerType(row!)
    await recordEvent(actor, 'runner_type.upsert', type.name, { image: type.image, cpus: type.cpus, memoryMb: type.memoryMb })
    return type
  },

  async deleteRunnerType(name: string, actor: Actor): Promise<void> {
    await requireType(name)
    const active = (await store.activeRunners()).filter((r) => r.type === name)
    if (active.length) throw new ServiceError(`runner type "${name}" has ${active.length} active runner(s)`, 'conflict')
    await db().run(sql`delete from slots where runner_type_id = (select id from runner_types where name = ${name})`)
    await db().run(sql`delete from runner_types where name = ${name}`)
    await recordEvent(actor, 'runner_type.delete', name)
  },

  async listSlots(): Promise<Slot[]> {
    return store.slotsView()
  },

  async setSlots(input: { host: string; type: string; count: number }, actor: Actor): Promise<Slot> {
    if (!Number.isInteger(input.count) || input.count < 0) throw new ServiceError('count must be an integer ≥ 0')
    const host = await requireHost(input.host)
    const type = await requireType(input.type)
    await db().run(sql`
      insert into slots (host_id, runner_type_id, count) values (${host.id}, ${type.id}, ${input.count})
      on conflict (host_id, runner_type_id) do update set count = excluded.count`)
    const slot = (await store.slotsView()).find((s) => s.host === host.name && s.type === type.name)!
    await recordEvent(actor, 'slots.set', `${host.name}/${type.name}`, { count: input.count })
    return slot
  },

  async listRepos(): Promise<RepoListItem[]> {
    return store.listRepos()
  },

  /** Which GitHub authentication this node runs with; the dashboard uses it to explain who delivers webhooks. */
  githubAuthKind(): 'app' | 'pat' | 'none' {
    return github().kind
  },

  /**
   * Creates or repairs the repo's `workflow_job` webhook and stores its id. With a GitHub App the App itself
   * delivers the events, so nothing is created and the outcome says `covered: 'app'`.
   */
  async ensureWebhook(fullName: string, actor: Actor): Promise<WebhookOutcome> {
    const repo = await store.repoByName(fullName)
    if (!repo?.adopted) throw new ServiceError(`repository "${fullName}" is not adopted`, 'not_found')
    const gh = github()
    if (gh.kind === 'app') {
      await recordEvent(actor, 'repo.webhook', fullName, { covered: 'app' })
      return { repo, covered: 'app', created: false }
    }
    const cfg = config()
    if (!cfg.publicUrl || !cfg.githubWebhookSecret) throw new ServiceError('PUBLIC_URL and GITHUB_WEBHOOK_SECRET must be set to create a webhook', 'invalid')
    let hook
    try {
      hook = await gh.ensureWebhook(fullName, `${cfg.publicUrl}/webhooks/github`, cfg.githubWebhookSecret)
    } catch (err) {
      throw new ServiceError(`GitHub refused the webhook on ${fullName}: ${err instanceof Error ? err.message : String(err)}`, 'unavailable')
    }
    if (!hook) throw new ServiceError(`GitHub returned no webhook for ${fullName}`, 'unavailable')
    const updated = (await store.setRepoWebhook(fullName, hook.id)) ?? repo
    await recordEvent(actor, 'repo.webhook', fullName, { webhookId: hook.id, created: hook.created })
    return { repo: updated, covered: 'hook', created: hook.created }
  },

  async adoptRepo(fullName: string, actor: Actor): Promise<Repo> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new ServiceError('repository must be "owner/name"')
    let info
    try {
      info = await github().getRepo(fullName)
    } catch (err) {
      throw new ServiceError(`GitHub did not return ${fullName}: ${err instanceof Error ? err.message : String(err)}`, 'unavailable')
    }
    const cfg = config()
    let webhookId: number | null = null
    if (cfg.publicUrl && cfg.githubWebhookSecret) {
      const hook = await github().ensureWebhook(info.fullName, `${cfg.publicUrl}/webhooks/github`, cfg.githubWebhookSecret)
      webhookId = hook?.id ?? null
    } else if (github().kind === 'pat') {
      logger.warn(`PUBLIC_URL or GITHUB_WEBHOOK_SECRET missing: ${info.fullName} relies on polling only`)
    }
    const [row] = await db().all(sql`
      insert into repos (full_name, adopted, is_private, webhook_id, adopted_at)
      values (${info.fullName}, true, ${info.isPrivate}, ${webhookId}, ${store.now()})
      on conflict (full_name) do update set adopted = true, is_private = excluded.is_private,
        webhook_id = coalesce(excluded.webhook_id, repos.webhook_id), adopted_at = excluded.adopted_at
      returning *`)
    await recordEvent(actor, 'repo.adopt', info.fullName, { webhookId })
    return toRepo(row!)
  },

  async unadoptRepo(fullName: string, actor: Actor): Promise<void> {
    const repo = await store.repoByName(fullName)
    if (!repo) throw new ServiceError(`repository "${fullName}" is unknown`, 'not_found')
    if (repo.webhookId !== null) {
      await github()
        .deleteWebhook(fullName, repo.webhookId)
        .catch((err) => logger.warn(`webhook removal for ${fullName} failed`, err instanceof Error ? err.message : String(err)))
    }
    await db().run(sql`update repos set adopted = false, webhook_id = null where full_name = ${fullName}`)
    await db().run(sql`update jobs set status = 'ignored', completed_at = ${store.now()} where repo = ${fullName} and status = 'queued'`)
    await recordEvent(actor, 'repo.unadopt', fullName)
  },

  async applyRunsOn(input: { fullName: string; mode: RunsOnMode; type: string; host?: string; workflows?: string[] }, actor: Actor): Promise<ApplyRunsOnResult> {
    const type = await requireType(input.type)
    if (input.host) await requireHost(input.host)
    const snippet = runsOnSnippet(type.name, input.host)
    if (input.mode === 'snippet') return { ok: true, message: `Paste this into each job of the workflow`, snippet }

    const repo = await store.repoByName(input.fullName)
    if (!repo?.adopted) throw new ServiceError(`repository "${input.fullName}" is not adopted`, 'invalid')
    const gh = github()
    const info = await gh.getRepo(input.fullName)
    const files = input.workflows?.length ? input.workflows : await gh.listWorkflowFiles(input.fullName, info.defaultBranch)
    if (!files.length) return { ok: false, message: 'no workflow files found under .github/workflows', snippet, files: [] }

    const branch = input.mode === 'pr' ? `octohatchery/runs-on-${type.name}-${Date.now().toString(36)}` : info.defaultBranch
    if (input.mode === 'pr') await gh.createBranch(input.fullName, branch, info.defaultBranch)
    const changedFiles: string[] = []
    let commitSha = ''
    for (const path of files) {
      const file = await gh.getFileContents(input.fullName, path, info.defaultBranch)
      if (!file) continue
      const { content, changed } = rewriteRunsOn(file.content, type.name, input.host)
      if (!changed) continue
      const res = await gh.putFile(input.fullName, { path, content, message: `ci: run on self-hosted ${type.name} runners`, sha: file.sha, branch })
      commitSha = res.commitSha
      changedFiles.push(path)
    }
    if (!changedFiles.length) return { ok: false, message: 'no runs-on values to change (only ubuntu-* and bare self-hosted are rewritten)', snippet, files: [] }
    if (input.mode === 'commit') {
      await recordEvent(actor, 'repo.runs_on.commit', input.fullName, { files: changedFiles, commitSha })
      return { ok: true, message: `updated ${changedFiles.length} workflow(s) on ${branch}`, snippet, commitSha, files: changedFiles }
    }
    const pr = await gh.openPullRequest(input.fullName, {
      title: `Run workflows on self-hosted ${type.name} runners`,
      body: `Switches \`runs-on\` to \`${snippet.replace('runs-on: ', '')}\` in: ${changedFiles.map((f) => `\`${f}\``).join(', ')}.`,
      head: branch,
      base: info.defaultBranch,
    })
    await recordEvent(actor, 'repo.runs_on.pr', input.fullName, { files: changedFiles, prUrl: pr.url })
    return { ok: true, message: `opened a pull request touching ${changedFiles.length} workflow(s)`, snippet, prUrl: pr.url, files: changedFiles }
  },

  /**
   * Jobs newest first. `q` is a case-insensitive substring over job name, repo and runner name; `since` keeps jobs
   * queued at or after that ISO time; `running` = claimed or in progress; `failed` = failure, timed out or cancelled.
   */
  async listJobs(filter: JobsFilter = {}): Promise<Job[]> {
    const where = [sql`1 = 1`]
    if (filter.repo) where.push(sql`j.repo = ${filter.repo}`)
    if (filter.status) where.push(sql`j.status = ${filter.status}`)
    if (filter.since) {
      const t = Date.parse(filter.since)
      if (Number.isNaN(t)) throw new ServiceError('since must be an ISO-8601 timestamp')
      where.push(sql`j.queued_at >= ${new Date(t).toISOString()}`)
    }
    if (filter.running) where.push(sql`j.status in ('claimed', 'in_progress')`)
    if (filter.failed) where.push(sql`j.conclusion in ('failure', 'timed_out', 'cancelled')`)
    if (filter.q) {
      const needle = `%${filter.q.trim().toLowerCase().replace(/[%_\\]/g, '\\$&')}%`
      where.push(sql`(lower(j.name) like ${needle} escape '\\' or lower(j.repo) like ${needle} escape '\\' or lower(coalesce(r.name, '')) like ${needle} escape '\\')`)
    }
    const rows = await db().all(sql`
      select j.* from jobs j left join runners r on r.id = j.runner_id
      where ${sql.join(where, sql` and `)} order by j.queued_at desc, j.id desc limit ${limitOf(filter.limit)}`)
    return rows.map(toJob).map(({ retries: _retries, ...job }) => job)
  },

  async getJob(id: number): Promise<Job> {
    const { retries: _retries, ...job } = await requireJob(id)
    return job
  },

  /**
   * Stored log lines of a job: `after` pages forward (exclusive seq), `tail` returns the last n lines instead.
   * `complete` is true once the final log is stored, or when the job finished and nothing can add lines any more.
   */
  async getJobLog(id: number, opts: { after?: number; limit?: number; tail?: number } = {}): Promise<JobLog> {
    const job = await requireJob(id)
    const limit = Math.min(Math.max(1, opts.limit ?? LOG_PAGE_LIMIT), LOG_PAGE_MAX)
    const lines = opts.tail !== undefined ? await store.logTail(id, Math.min(Math.max(1, opts.tail), LOG_PAGE_MAX)) : await store.logLinesAfter(id, opts.after ?? 0, limit)
    return { lines, source: job.logSource, truncated: job.logTruncated, complete: await logComplete(job) }
  },

  async listRunners(filter: { host?: string; state?: RunnerState; limit?: number } = {}): Promise<Runner[]> {
    const where = [sql`1 = 1`]
    if (filter.host) where.push(sql`host = ${filter.host}`)
    if (filter.state) where.push(sql`state = ${filter.state}`)
    const rows = await db().all(sql`select * from runners where ${sql.join(where, sql` and `)} order by created_at desc, id desc limit ${limitOf(filter.limit)}`)
    return rows.map(toRunner).map(({ githubRunnerId: _id, ...runner }) => runner)
  },

  async getRunner(id: number): Promise<Runner> {
    const runner = await store.runnerById(id)
    if (!runner) throw new ServiceError(`runner ${id} is unknown`, 'not_found')
    const { githubRunnerId: _ghId, ...out } = runner
    return out
  },

  /** Starts a runner outside the queue. Local host: spawned now; other hosts: their scheduler picks it up. */
  async spawn(input: { type: string; host: string }, actor: Actor): Promise<Runner> {
    const type = await requireType(input.type)
    const host = await requireHost(input.host)
    if (host.status !== 'online') throw new ServiceError(`host "${host.name}" is offline`, 'unavailable')
    const slot = (await store.slotsView()).find((s) => s.host === host.name && s.type === type.name)
    if (!slot || slot.free < 1) throw new ServiceError(`no free ${type.name} slot on ${host.name}`, 'conflict')
    const name = `${type.name}-${host.name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const runner = await store.insertRunner({ name, host: host.name, type: type.name, jobId: null, repo: null, jobName: null })
    await recordEvent(actor, 'runner.request', runner.name, { host: host.name, type: type.name })
    if (host.name !== config().hostName) return runner
    const live = await materialise(runner, actor)
    if (!live) throw new ServiceError(`runner ${runner.name} failed to start; see events`, 'unavailable')
    return live
  },

  /** Stops a runner: container removed (local host) or left for that host's reaper, GitHub registration deleted. */
  async kill(runnerId: number, actor: Actor): Promise<void> {
    const runner = await store.runnerById(runnerId)
    if (!runner) throw new ServiceError(`runner ${runnerId} is unknown`, 'not_found')
    if (!store.ACTIVE_RUNNER_STATES.includes(runner.state)) throw new ServiceError(`runner ${runner.name} is already ${runner.state}`, 'conflict')
    if (runner.containerId && runner.host === config().hostName) await backend().remove(runner.containerId)
    if (runner.githubRunnerId !== null && runner.repo) {
      await github()
        .deleteRunner(runner.repo, runner.githubRunnerId)
        .catch((err) => logger.warn(`deregister ${runner.name} failed`, err instanceof Error ? err.message : String(err)))
    }
    await store.updateRunner(runner.id, { state: 'removed', exitedAt: store.now() })
    if (runner.jobId !== null) {
      const job = await store.jobById(runner.jobId)
      if (job && job.status === 'claimed') await store.updateJob(job.id, { status: 'queued', runnerId: null })
    }
    await recordEvent(actor, 'runner.kill', runner.name, { host: runner.host, type: runner.type })
  },

  async listEvents(filter: { limit?: number } = {}): Promise<Event[]> {
    const rows = await db().all(sql`select * from events order by id desc limit ${limitOf(filter.limit)}`)
    return rows.map(toEvent)
  },

  async getSettings(): Promise<Record<string, string>> {
    return settings.all()
  },

  async setSetting(key: string, value: string, actor: Actor): Promise<void> {
    if (!(key in SETTING_DEFAULTS)) throw new ServiceError(`unknown setting "${key}" (known: ${Object.keys(SETTING_DEFAULTS).join(', ')})`, 'not_found')
    if (key === 'log_level') {
      if (!LOG_LEVELS.includes(value)) throw new ServiceError(`log_level must be one of ${LOG_LEVELS.join(', ')}`)
    } else if (key === 'buildkit_host') {
      if (!/^(tcp|unix):\/\/.+/.test(value)) throw new ServiceError('buildkit_host must be a tcp:// or unix:// address')
    } else if (key.startsWith('ui_')) {
      if (!/^[a-z0-9-]{1,40}$/.test(value)) throw new ServiceError(`${key} must be a short lowercase identifier`)
    } else if (!/^\d+$/.test(value)) {
      throw new ServiceError(`${key} must be a non-negative integer`)
    }
    await settings.set(key, value)
    await recordEvent(actor, 'setting.set', key, { value })
  },

  async health(): Promise<HealthSnapshot> {
    const cfg = config()
    const dbOk = await db()
      .ping()
      .catch(() => false)
    const dockerOk = await backend()
      .ping()
      .catch(() => false)
    const slots = dbOk ? await store.slotsView().catch(() => []) : []
    return {
      ok: dbOk && dockerOk,
      mode: cfg.mode,
      host: cfg.hostName,
      db: dbOk,
      docker: dockerOk,
      leader: isLeader(),
      slots,
      queued: dbOk ? await store.countJobs('queued').catch(() => 0) : 0,
      runnersBusy: dbOk ? await store.countRunners('busy').catch(() => 0) : 0,
      lastWebhookAt: getLastWebhookAt(),
      version: pkg.version,
    }
  },
}


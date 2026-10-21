import { verify } from '@octokit/webhooks-methods'
import { z } from 'zod'
import { config } from './config'
import { recordEvent } from './events'
import { notServedReason } from './github/accounts'
import { github } from './github/auth'
import { SELF_HOSTED } from './labels'
import { log } from './log'
import { metrics } from './metrics'
import { insertJobIfNew, jobByGitHubId, rebindJob, repoByName, runnerById, updateJob, updateRunner, type JobRow } from './store'
import type { JobStep } from './types'

const logger = log('http')

/** `workflow_job.steps[]` as GitHub sends it; unknown shapes in the list are dropped, not rejected. */
export const StepPayload = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable().optional(),
  number: z.number(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
})
export type StepPayload = z.infer<typeof StepPayload>

export const toSteps = (steps: StepPayload[] | undefined): JobStep[] =>
  (steps ?? [])
    .map((s) => ({ number: s.number, name: s.name, status: s.status, conclusion: s.conclusion ?? null, startedAt: s.started_at ?? null, completedAt: s.completed_at ?? null }))
    .sort((a, b) => a.number - b.number)

export const WorkflowJobPayload = z.object({
  action: z.enum(['queued', 'in_progress', 'completed', 'waiting']),
  workflow_job: z.object({
    id: z.number(),
    run_id: z.number(),
    name: z.string(),
    labels: z.array(z.string()),
    status: z.string(),
    conclusion: z.string().nullable().optional(),
    html_url: z.string().default(''),
    runner_name: z.string().nullable().optional(),
    created_at: z.string().optional(),
    started_at: z.string().nullable().optional(),
    completed_at: z.string().nullable().optional(),
    steps: z.array(StepPayload).optional(),
  }),
  repository: z.object({ full_name: z.string() }),
  /** Present on GitHub App deliveries: the installation that sent it. */
  installation: z.object({ id: z.number() }).optional(),
})
export type WorkflowJobPayload = z.infer<typeof WorkflowJobPayload>

export type WebhookOutcome = { status: number; message: string }

let lastWebhookAt: string | null = null
export function getLastWebhookAt(): string | null {
  return lastWebhookAt
}

/** True when `signature` (X-Hub-Signature-256) matches the raw body under the configured secret. */
export async function verifySignature(rawBody: string, signature: string | undefined, secret = config().githubWebhookSecret): Promise<boolean> {
  if (!secret || !signature) return false
  try {
    return await verify(secret, rawBody, signature)
  } catch {
    return false
  }
}

/** Handles one verified delivery. `event` is the X-GitHub-Event header. */
export async function handleWebhook(event: string | undefined, rawBody: string): Promise<WebhookOutcome> {
  lastWebhookAt = new Date().toISOString()
  if (event === 'ping') return { status: 200, message: 'pong' }
  if (event !== 'workflow_job') {
    metrics.webhooks.inc({ outcome: 'skipped' })
    return { status: 202, message: `event ${event ?? 'unknown'} ignored` }
  }
  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    metrics.webhooks.inc({ outcome: 'invalid' })
    return { status: 400, message: 'body is not JSON' }
  }
  const parsed = WorkflowJobPayload.safeParse(json)
  if (!parsed.success) {
    metrics.webhooks.inc({ outcome: 'invalid' })
    return { status: 400, message: `payload rejected: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}` }
  }
  const outcome = await applyWorkflowJob(parsed.data)
  metrics.webhooks.inc({ outcome: outcome.status < 300 ? 'ok' : 'rejected' })
  return outcome
}

/**
 * Moves the job to the runner GitHub says runs it (see `rebindJob`); one audit event per move. A runner name that
 * is not ours (or no name) leaves the binding as it is.
 */
async function followGitHub(job: JobRow, runnerName: string | null | undefined): Promise<JobRow> {
  if (!runnerName) return job
  const moved = await rebindJob(job.id, runnerName)
  if (!moved) return job
  const target = `${job.repo}#${job.githubJobId}`
  logger.info(`${target} "${job.name}" runs on ${runnerName}, not on runner ${job.runnerId ?? 'none'}: binding moved${moved.displacedJobId !== null ? ` (job ${moved.displacedJobId} → runner ${moved.previousRunnerId ?? 'none'})` : ''}`)
  await recordEvent('webhook', 'job.rebound', target, { runner: runnerName, from: job.runnerId, displacedJob: moved.displacedJobId })
  return moved.job
}

export async function applyWorkflowJob(p: WorkflowJobPayload): Promise<WebhookOutcome> {
  const wj = p.workflow_job
  const repoName = p.repository.full_name
  const target = `${repoName}#${wj.id}`
  // Installations on accounts this instance does not serve (`github_accounts`) are dropped before anything else:
  // never a job row; one audit event per job (on `queued`), a log line per delivery.
  const notServed = await notServedReason(github().installs, repoName.split('/')[0]!, p.installation?.id)
  if (notServed) {
    logger.info(`webhook ${p.action} ${target} dropped: ${notServed}`)
    if (p.action === 'queued') await recordEvent('github', 'webhook.ignored', repoName, { reason: notServed, job: wj.id, installation: p.installation?.id ?? null })
    return { status: 200, message: `ignored: ${notServed}` }
  }
  switch (p.action) {
    case 'queued': {
      const repo = await repoByName(repoName)
      const selfHosted = wj.labels.map((l) => l.toLowerCase()).includes(SELF_HOSTED)
      // Jobs of unadopted repos and jobs for hosted runners are not ours: an audit event, no job row.
      // The row table holds only work this instance may run, so history and retention stay about that.
      if (!repo?.adopted || !selfHosted) {
        const reason = !repo?.adopted ? 'repository not adopted' : 'labels do not include self-hosted'
        if (repo?.adopted) await recordEvent('webhook', 'job.ignored', target, { reason, labels: wj.labels })
        return { status: 200, message: `ignored: ${reason}` }
      }
      const job = await insertJobIfNew({
        repo: repoName,
        githubJobId: wj.id,
        runId: wj.run_id,
        name: wj.name,
        labels: wj.labels,
        htmlUrl: wj.html_url,
        queuedAt: wj.created_at ?? new Date().toISOString(),
        status: 'queued',
      })
      if (!job) return { status: 200, message: 'job already known' }
      await recordEvent('webhook', 'job.queued', target, { name: wj.name, labels: wj.labels })
      logger.info(`queued ${target} "${wj.name}" [${wj.labels.join(', ')}]`)
      return { status: 200, message: 'job queued' }
    }
    case 'in_progress': {
      const known = await jobByGitHubId(wj.id)
      if (!known) return { status: 200, message: 'job unknown, ignored' }
      const job = await followGitHub(known, wj.runner_name)
      await updateJob(job.id, { status: 'in_progress', startedAt: wj.started_at ?? new Date().toISOString(), steps: toSteps(wj.steps) })
      if (job.runnerId !== null) await updateRunner(job.runnerId, { state: 'busy' })
      await recordEvent('webhook', 'job.started', target, { runner: wj.runner_name ?? null })
      return { status: 200, message: 'job in progress' }
    }
    case 'completed': {
      const known = await jobByGitHubId(wj.id)
      if (!known) return { status: 200, message: 'job unknown, ignored' }
      // The in_progress delivery may have been lost: bind to the runner GitHub names before closing anything.
      const job = await followGitHub(known, wj.runner_name)
      const completedAt = wj.completed_at ?? new Date().toISOString()
      await updateJob(job.id, { status: 'completed', conclusion: wj.conclusion ?? null, completedAt, ...(wj.steps ? { steps: toSteps(wj.steps) } : {}) })
      if (job.runnerId !== null) {
        const runner = await runnerById(job.runnerId)
        if (runner && (runner.state === 'busy' || runner.state === 'idle')) await updateRunner(runner.id, { state: 'exited', exitedAt: completedAt })
      }
      await recordEvent('webhook', 'job.completed', target, { conclusion: wj.conclusion ?? null })
      return { status: 200, message: 'job completed' }
    }
    default:
      return { status: 202, message: `action ${p.action} ignored` }
  }
}

import type { Octokit } from '@octokit/rest'
import { z } from 'zod'
import { log } from '../log'
import type { JobAnnotation } from '../types'
import { splitRepo, type FileContents, type GitHubClient, type JobDetails, type QueuedJob, type RepoInfo } from './types'

const logger = log('github')

/** One check-run annotation as GitHub returns it; items that do not fit are dropped, not fatal. */
export const AnnotationPayload = z.object({
  path: z.string().nullable().optional(),
  start_line: z.number().nullable().optional(),
  end_line: z.number().nullable().optional(),
  annotation_level: z.enum(['failure', 'warning', 'notice']),
  title: z.string().nullable().optional(),
  message: z.string(),
})

/** Longest annotation message kept; GitHub allows 64 KB, the page shows a line. */
const ANNOTATION_MESSAGE_MAX = 2000

/** GitHub's annotation list → ours: schema-checked per item, capped at `max`, messages cut at 2000 characters. */
export function parseAnnotations(data: unknown, max: number): JobAnnotation[] {
  if (!Array.isArray(data)) throw new Error(`annotations: expected a list, got ${typeof data}`)
  const out: JobAnnotation[] = []
  for (const item of data) {
    const a = AnnotationPayload.safeParse(item)
    if (!a.success) continue
    out.push({
      level: a.data.annotation_level,
      message: a.data.message.slice(0, ANNOTATION_MESSAGE_MAX),
      title: a.data.title || null,
      path: a.data.path || null,
      startLine: a.data.start_line ?? null,
      endLine: a.data.end_line ?? null,
    })
    if (out.length >= max) break
  }
  return out
}

/** Reads a response body up to `maxBytes`; stops and throws as soon as it passes the cap. */
async function readCapped(res: Response, maxBytes: number, what: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (declared > maxBytes) throw new Error(`${what}: ${declared} bytes, over the ${maxBytes} byte cap`)
  if (!res.body) return new Uint8Array(await res.arrayBuffer())
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`${what}: over the ${maxBytes} byte cap`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/**
 * REST calls shared by the `app` and `pat` adapters. `getOctokit` yields a client authorised for the repo;
 * the adapters add what differs (webhooks, repository listing).
 */
export function restClient(
  kind: GitHubClient['kind'],
  getOctokit: (repoFullName: string) => Promise<Octokit>,
  extra: Pick<GitHubClient, 'ensureWebhook' | 'deleteWebhook' | 'listInstallationRepos' | 'permissions' | 'installs'>,
): GitHubClient {
  const call = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      const out = await fn()
      logger.debug(`${what}: ok`)
      return out
    } catch (err) {
      logger.warn(`${what}: failed`, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  return {
    kind,
    getInstallationOctokit: getOctokit,
    ...extra,

    async createJitConfig({ repo, name, labels, runnerGroupId }) {
      const o = await getOctokit(repo)
      const { owner, repo: r } = splitRepo(repo)
      const res = await call(`POST ${repo} generate-jitconfig ${name}`, () =>
        o.request('POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig', {
          owner,
          repo: r,
          name,
          labels,
          runner_group_id: runnerGroupId ?? 1,
          work_folder: '_work',
        }),
      )
      return { runnerId: res.data.runner.id, encodedJitConfig: res.data.encoded_jit_config }
    },

    async deleteRunner(repo, runnerId) {
      const o = await getOctokit(repo)
      const { owner, repo: r } = splitRepo(repo)
      await call(`DELETE ${repo} runner ${runnerId}`, async () => {
        try {
          await o.rest.actions.deleteSelfHostedRunnerFromRepo({ owner, repo: r, runner_id: runnerId })
        } catch (err) {
          if ((err as { status?: number }).status === 404) return // already gone
          throw err
        }
      })
    },

    async getRunner(repo, runnerId) {
      const o = await getOctokit(repo)
      const { owner, repo: r } = splitRepo(repo)
      return call(`GET ${repo} runner ${runnerId}`, async () => {
        try {
          const res = await o.rest.actions.getSelfHostedRunnerForRepo({ owner, repo: r, runner_id: runnerId })
          return { status: res.data.status, busy: res.data.busy }
        } catch (err) {
          if ((err as { status?: number }).status === 404) return null
          throw err
        }
      })
    },

    async listQueuedJobs(repo) {
      const o = await getOctokit(repo)
      const { owner, repo: r } = splitRepo(repo)
      const runs = await call(`GET ${repo} runs?status=queued`, () =>
        o.rest.actions.listWorkflowRunsForRepo({ owner, repo: r, status: 'queued', per_page: 50 }),
      )
      const out: QueuedJob[] = []
      for (const run of runs.data.workflow_runs) {
        const jobs = await call(`GET ${repo} run ${run.id} jobs`, () =>
          o.rest.actions.listJobsForWorkflowRun({ owner, repo: r, run_id: run.id, per_page: 100 }),
        )
        for (const j of jobs.data.jobs) {
          if (j.status !== 'queued') continue
          out.push({
            githubJobId: j.id,
            runId: run.id,
            name: j.name,
            labels: j.labels ?? [],
            htmlUrl: j.html_url ?? run.html_url,
            queuedAt: j.created_at ?? run.created_at,
          })
        }
      }
      return out
    },

    async getRepo(fullName): Promise<RepoInfo> {
      const o = await getOctokit(fullName)
      const { owner, repo } = splitRepo(fullName)
      const res = await call(`GET repo ${fullName}`, () => o.rest.repos.get({ owner, repo }))
      return { fullName: res.data.full_name, isPrivate: res.data.private, defaultBranch: res.data.default_branch }
    },

    async getFileContents(fullName, path, ref): Promise<FileContents | null> {
      const o = await getOctokit(fullName)
      const { owner, repo } = splitRepo(fullName)
      try {
        const res = await o.rest.repos.getContent({ owner, repo, path, ref })
        if (Array.isArray(res.data) || res.data.type !== 'file') return null
        return { content: Buffer.from(res.data.content, 'base64').toString('utf8'), sha: res.data.sha }
      } catch (err) {
        if ((err as { status?: number }).status === 404) return null
        throw err
      }
    },

    async putFile(fullName, { path, content, message, sha, branch }) {
      const o = await getOctokit(fullName)
      const { owner, repo } = splitRepo(fullName)
      const res = await call(`PUT ${fullName} ${path}@${branch}`, () =>
        o.rest.repos.createOrUpdateFileContents({
          owner,
          repo,
          path,
          message,
          content: Buffer.from(content, 'utf8').toString('base64'),
          sha,
          branch,
        }),
      )
      return { commitSha: res.data.commit.sha ?? '', htmlUrl: res.data.commit.html_url ?? '' }
    },

    async createBranch(fullName, name, fromBranch) {
      const o = await getOctokit(fullName)
      const { owner, repo } = splitRepo(fullName)
      const base = await o.rest.git.getRef({ owner, repo, ref: `heads/${fromBranch}` })
      await call(`POST ${fullName} branch ${name}`, () =>
        o.rest.git.createRef({ owner, repo, ref: `refs/heads/${name}`, sha: base.data.object.sha }),
      )
    },

    async deleteBranch(fullName, name) {
      const o = await getOctokit(fullName)
      const { owner, repo } = splitRepo(fullName)
      await call(`DELETE ${fullName} branch ${name}`, async () => {
        try {
          await o.rest.git.deleteRef({ owner, repo, ref: `heads/${name}` })
        } catch (err) {
          if ((err as { status?: number }).status === 404 || (err as { status?: number }).status === 422) return // already gone
          throw err
        }
      })
    },

    async openPullRequest(fullName, { title, body, head, base }) {
      const o = await getOctokit(fullName)
      const { owner, repo } = splitRepo(fullName)
      const res = await call(`POST ${fullName} pull ${head}→${base}`, () => o.rest.pulls.create({ owner, repo, title, body, head, base }))
      return { url: res.data.html_url, number: res.data.number }
    },

    async getPullRequest(fullName, number) {
      const o = await getOctokit(fullName)
      const { owner, repo } = splitRepo(fullName)
      try {
        const res = await call(`GET ${fullName} pull ${number}`, () => o.rest.pulls.get({ owner, repo, pull_number: number }))
        return { url: res.data.html_url, state: res.data.state }
      } catch (err) {
        if ((err as { status?: number }).status === 404) return null
        throw err
      }
    },

    async getJobLog(fullName, githubJobId) {
      const o = await getOctokit(fullName)
      const { owner, repo } = splitRepo(fullName)
      const res = await call(`GET ${fullName} job ${githubJobId} logs`, () => o.rest.actions.downloadJobLogsForWorkflowRun({ owner, repo, job_id: githubJobId }))
      const data: unknown = res.data
      if (typeof data === 'string') return data
      if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
      if (data && typeof data === 'object' && 'byteLength' in data) return Buffer.from(data as Uint8Array).toString('utf8')
      throw new Error(`job ${githubJobId} log: unexpected response body (${typeof data})`)
    },

    async getJob(fullName, githubJobId): Promise<JobDetails> {
      const o = await getOctokit(fullName)
      const { owner, repo } = splitRepo(fullName)
      const res = await call(`GET ${fullName} job ${githubJobId}`, () => o.rest.actions.getJobForWorkflowRun({ owner, repo, job_id: githubJobId }))
      const j = res.data
      return {
        status: j.status,
        conclusion: j.conclusion ?? null,
        startedAt: j.started_at ?? null,
        completedAt: j.completed_at ?? null,
        runId: j.run_id,
        runAttempt: j.run_attempt ?? 1,
        name: j.name,
        steps: (j.steps ?? [])
          .map((s) => ({ number: s.number, name: s.name, status: s.status, conclusion: s.conclusion ?? null, startedAt: s.started_at ?? null, completedAt: s.completed_at ?? null }))
          .sort((a, b) => a.number - b.number),
      }
    },

    async getRunAttemptLogs(fullName, runId, attempt, maxBytes) {
      const o = await getOctokit(fullName)
      const { owner, repo } = splitRepo(fullName)
      const what = `GET ${fullName} run ${runId} attempt ${attempt} logs`
      return call(what, async () => {
        // GitHub answers with a short-lived redirect to the zip; fetching it here keeps the download under the cap.
        const res = await o.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/logs', { owner, repo, run_id: runId, attempt_number: attempt, request: { redirect: 'manual' } })
        const location = (res.headers as Record<string, string | undefined>).location
        if (!location) throw new Error(`${what}: no redirect to the archive (HTTP ${res.status})`)
        const zip = await fetch(location)
        if (!zip.ok) throw Object.assign(new Error(`${what}: archive download answered HTTP ${zip.status}`), { status: zip.status })
        return readCapped(zip, maxBytes, what)
      })
    },

    async listJobAnnotations(fullName, githubJobId, max = 50) {
      const o = await getOctokit(fullName)
      const { owner, repo } = splitRepo(fullName)
      const res = await call(`GET ${fullName} check-run ${githubJobId} annotations`, () => o.request('GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations', { owner, repo, check_run_id: githubJobId, per_page: Math.min(100, max) }))
      return parseAnnotations(res.data, max)
    },

    async listWorkflowFiles(fullName, ref) {
      const o = await getOctokit(fullName)
      const { owner, repo } = splitRepo(fullName)
      try {
        const res = await o.rest.repos.getContent({ owner, repo, path: '.github/workflows', ref })
        if (!Array.isArray(res.data)) return []
        return res.data.filter((e) => e.type === 'file' && /\.ya?ml$/.test(e.name)).map((e) => e.path)
      } catch (err) {
        if ((err as { status?: number }).status === 404) return []
        throw err
      }
    },
  }
}

/** HTTP status of a failed Octokit call, or undefined for anything that is not a request error. */
export function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown }).status
  return typeof s === 'number' ? s : undefined
}

/** GitHub's own message for a failed call (`Resource not accessible by integration`, …), with the status. */
export function githubMessage(err: unknown): string {
  const status = statusOf(err)
  const msg = err instanceof Error ? err.message : String(err)
  return status ? `${msg.replace(/ - https:\/\/docs\.github\.com\S*/, '')} (HTTP ${status})` : msg
}

/** Lists at most `max` items from a paginated endpoint: stops after the page that crosses the cap. */
export async function paginateUpTo<T>(iterator: AsyncIterable<{ data: T[] }>, max: number): Promise<T[]> {
  const out: T[] = []
  for await (const page of iterator) {
    out.push(...page.data)
    if (out.length >= max) break
  }
  return out.slice(0, max)
}

/**
 * Token mode: fine-grained tokens expose no grant list, so cheap reads on one adopted repository prove what is
 * definitely missing (403/404 → `none`); a successful read proves read access only and is reported as `unknown`.
 * Classic tokens announce their scopes in `x-oauth-scopes`, which maps to the permissions directly.
 */
export async function probeTokenPermissions(o: Octokit, probeRepo: string | undefined): Promise<{ granted: Record<string, string>; account?: string; note: string }> {
  const user = await o.request('GET /user')
  const scopes = (user.headers['x-oauth-scopes'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  logger.info(`GET /user: ${user.data.login}${scopes.length ? ` scopes=${scopes.join(',')}` : ' (fine-grained token)'}`)
  if (scopes.length) {
    const repoScope = scopes.includes('repo')
    const granted: Record<string, string> = {
      metadata: 'read',
      administration: repoScope ? 'write' : 'none',
      actions: repoScope ? 'write' : 'none',
      contents: repoScope ? 'write' : 'none',
      pull_requests: repoScope ? 'write' : 'none',
      workflows: scopes.includes('workflow') ? 'write' : 'none',
      webhooks: repoScope || scopes.includes('admin:repo_hook') || scopes.includes('write:repo_hook') ? 'write' : 'none',
    }
    return { granted, account: user.data.login, note: 'Classic token: permissions derived from its scopes.' }
  }
  const granted: Record<string, string> = { metadata: 'read', contents: 'unknown', workflows: 'unknown', pull_requests: 'unknown', actions: 'unknown', administration: 'unknown', webhooks: 'unknown' }
  if (!probeRepo) return { granted, account: user.data.login, note: 'Fine-grained token: GitHub does not list its grants. Adopt a repository to let the probe check runner and webhook access.' }
  const { owner, repo } = splitRepo(probeRepo)
  const probe = async (key: string, what: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      logger.debug(`probe ${what}: ok`)
    } catch (err) {
      const status = statusOf(err)
      logger.warn(`probe ${what}: failed`, githubMessage(err))
      if (status === 403 || status === 404) granted[key] = 'none'
    }
  }
  await probe('administration', `GET ${probeRepo} runners`, () => o.rest.actions.listSelfHostedRunnersForRepo({ owner, repo, per_page: 1 }))
  await probe('actions', `GET ${probeRepo} runs`, () => o.rest.actions.listWorkflowRunsForRepo({ owner, repo, per_page: 1 }))
  await probe('webhooks', `GET ${probeRepo} hooks`, () => o.rest.repos.listWebhooks({ owner, repo, per_page: 1 }))
  await probe('contents', `GET ${probeRepo} contents`, () => o.rest.repos.getContent({ owner, repo, path: '' }))
  return {
    granted,
    account: user.data.login,
    note: `Fine-grained token: GitHub does not list its grants. Reads on ${probeRepo} proved access where marked; write levels cannot be verified without writing.`,
  }
}

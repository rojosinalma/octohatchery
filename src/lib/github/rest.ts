import type { Octokit } from '@octokit/rest'
import { log } from '../log'
import { splitRepo, type FileContents, type GitHubClient, type QueuedJob, type RepoInfo } from './types'

const logger = log('github')

/**
 * REST calls shared by the `app` and `pat` adapters. `getOctokit` yields a client authorised for the repo;
 * the adapters add what differs (webhooks, repository listing).
 */
export function restClient(
  kind: GitHubClient['kind'],
  getOctokit: (repoFullName: string) => Promise<Octokit>,
  extra: Pick<GitHubClient, 'ensureWebhook' | 'deleteWebhook' | 'listInstallationRepos'>,
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
      return { commitSha: res.data.commit.sha ?? '' }
    },

    async createBranch(fullName, name, fromBranch) {
      const o = await getOctokit(fullName)
      const { owner, repo } = splitRepo(fullName)
      const base = await o.rest.git.getRef({ owner, repo, ref: `heads/${fromBranch}` })
      await call(`POST ${fullName} branch ${name}`, () =>
        o.rest.git.createRef({ owner, repo, ref: `refs/heads/${name}`, sha: base.data.object.sha }),
      )
    },

    async openPullRequest(fullName, { title, body, head, base }) {
      const o = await getOctokit(fullName)
      const { owner, repo } = splitRepo(fullName)
      const res = await call(`POST ${fullName} pull ${head}→${base}`, () => o.rest.pulls.create({ owner, repo, title, body, head, base }))
      return { url: res.data.html_url }
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

import type { Octokit } from '@octokit/rest'
import type { GitHubAuthAdapter, GitHubClient, QueuedJob } from '../types'

/** In-memory stand-in for tests: deterministic answers, records every call, never talks to GitHub. */
export type FakeGitHub = GitHubClient & {
  calls: { method: string; args: unknown[] }[]
  queued: Map<string, QueuedJob[]>
  files: Map<string, string>
  deletedRunners: number[]
  /** `repo#githubJobId` → log text; a missing entry answers 404 like GitHub does before the log is ready. */
  jobLogs: Map<string, string>
}

export function createFakeGitHub(): FakeGitHub {
  const calls: FakeGitHub['calls'] = []
  const queued = new Map<string, QueuedJob[]>()
  const files = new Map<string, string>()
  const deletedRunners: number[] = []
  const jobLogs = new Map<string, string>()
  let nextRunnerId = 1000
  const rec = (method: string, ...args: unknown[]) => calls.push({ method, args })
  return {
    kind: 'none',
    calls,
    queued,
    files,
    deletedRunners,
    jobLogs,
    async getInstallationOctokit(): Promise<Octokit> {
      throw new Error('GITHUB_AUTH=none has no Octokit')
    },
    async createJitConfig(input) {
      rec('createJitConfig', input)
      return { runnerId: nextRunnerId++, encodedJitConfig: `fake-jit-${input.name}` }
    },
    async deleteRunner(repo, runnerId) {
      rec('deleteRunner', repo, runnerId)
      deletedRunners.push(runnerId)
    },
    async listQueuedJobs(repo) {
      rec('listQueuedJobs', repo)
      return queued.get(repo) ?? []
    },
    async ensureWebhook(repo, url, secret) {
      rec('ensureWebhook', repo, url, secret)
      return { id: 1, created: true }
    },
    async deleteWebhook(repo, hookId) {
      rec('deleteWebhook', repo, hookId)
    },
    async listInstallationRepos() {
      rec('listInstallationRepos')
      return [{ fullName: 'example/repo', isPrivate: false, defaultBranch: 'main' }]
    },
    async getRepo(fullName) {
      rec('getRepo', fullName)
      return { fullName, isPrivate: false, defaultBranch: 'main' }
    },
    async getFileContents(repo, path) {
      rec('getFileContents', repo, path)
      const content = files.get(`${repo}:${path}`)
      return content === undefined ? null : { content, sha: 'fake-sha' }
    },
    async putFile(repo, input) {
      rec('putFile', repo, input)
      files.set(`${repo}:${input.path}`, input.content)
      return { commitSha: 'fake-commit' }
    },
    async createBranch(repo, name, fromBranch) {
      rec('createBranch', repo, name, fromBranch)
    },
    async openPullRequest(repo, input) {
      rec('openPullRequest', repo, input)
      return { url: `https://example.invalid/${repo}/pull/1` }
    },
    async getJobLog(repo, githubJobId) {
      rec('getJobLog', repo, githubJobId)
      const text = jobLogs.get(`${repo}#${githubJobId}`)
      if (text === undefined) throw Object.assign(new Error(`Not Found: log for job ${githubJobId}`), { status: 404 })
      return text
    },
    async listWorkflowFiles(repo) {
      rec('listWorkflowFiles', repo)
      return [...files.keys()].filter((k) => k.startsWith(`${repo}:.github/workflows/`)).map((k) => k.slice(repo.length + 1))
    },
  }
}

export const noneAuth: GitHubAuthAdapter = {
  kind: 'none',
  create: createFakeGitHub,
}

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
  /** Branches created by `createBranch` and not yet deleted (`repo:name`). */
  branches: Set<string>
  /** Method name → error message; the next call to that method throws it with `status: 403`. */
  failOn: Map<string, string>
  /** What `permissions()` reports as granted (empty = nothing known). */
  granted: Record<string, string>
}

export function createFakeGitHub(): FakeGitHub {
  const calls: FakeGitHub['calls'] = []
  const queued = new Map<string, QueuedJob[]>()
  const files = new Map<string, string>()
  const deletedRunners: number[] = []
  const jobLogs = new Map<string, string>()
  const branches = new Set<string>()
  const failOn = new Map<string, string>()
  const pulls = new Map<string, { url: string; state: string }>()
  const granted: Record<string, string> = {}
  let nextRunnerId = 1000
  const rec = (method: string, ...args: unknown[]) => calls.push({ method, args })
  return {
    kind: 'none',
    calls,
    queued,
    files,
    deletedRunners,
    jobLogs,
    branches,
    failOn,
    granted,
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
      if (failOn.has('putFile')) throw Object.assign(new Error(failOn.get('putFile')), { status: 403 })
      files.set(`${repo}:${input.path}`, input.content)
      return { commitSha: 'fake-commit', htmlUrl: `https://example.invalid/${repo}/commit/fake-commit` }
    },
    async createBranch(repo, name, fromBranch) {
      rec('createBranch', repo, name, fromBranch)
      branches.add(`${repo}:${name}`)
    },
    async deleteBranch(repo, name) {
      rec('deleteBranch', repo, name)
      branches.delete(`${repo}:${name}`)
    },
    async openPullRequest(repo, input) {
      rec('openPullRequest', repo, input)
      if (failOn.has('openPullRequest')) throw Object.assign(new Error(failOn.get('openPullRequest')), { status: 403 })
      pulls.set(`${repo}#1`, { url: `https://example.invalid/${repo}/pull/1`, state: 'open' })
      return { url: `https://example.invalid/${repo}/pull/1`, number: 1 }
    },
    async getPullRequest(repo, number) {
      rec('getPullRequest', repo, number)
      return pulls.get(`${repo}#${number}`) ?? null
    },
    async permissions(probeRepo) {
      rec('permissions', probeRepo)
      return { source: 'none', granted: { ...granted } }
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

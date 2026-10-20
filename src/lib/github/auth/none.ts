import type { Octokit } from '@octokit/rest'
import type { GitHubAuthAdapter, GitHubClient, JobDetails, QueuedJob } from '../types'

/** In-memory stand-in for tests: deterministic answers, records every call, never talks to GitHub. */
export type FakeGitHub = GitHubClient & {
  calls: { method: string; args: unknown[] }[]
  queued: Map<string, QueuedJob[]>
  files: Map<string, string>
  deletedRunners: number[]
  /** `repo#githubJobId` → log text; a missing entry answers 404 like GitHub does before the log is ready. */
  jobLogs: Map<string, string>
  /** `repo#githubJobId` → job details; a missing entry answers a deterministic two-step job built from the log's timestamps. */
  jobDetails: Map<string, JobDetails>
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
  const jobDetails = new Map<string, JobDetails>()
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
    jobDetails,
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
    async getJob(repo, githubJobId) {
      rec('getJob', repo, githubJobId)
      if (failOn.has('getJob')) throw Object.assign(new Error(failOn.get('getJob')), { status: 403 })
      return jobDetails.get(`${repo}#${githubJobId}`) ?? fakeJobDetails()
    },
    async listWorkflowFiles(repo) {
      rec('listWorkflowFiles', repo)
      return [...files.keys()].filter((k) => k.startsWith(`${repo}:.github/workflows/`)).map((k) => k.slice(repo.length + 1))
    },
  }
}

/** Two finished steps a minute apart: enough for the steps view and the finaliser tests to assert against. */
export function fakeJobDetails(): JobDetails {
  return {
    status: 'completed',
    conclusion: 'success',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:02:00Z',
    steps: [
      { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z' },
      { number: 2, name: 'Run tests', status: 'completed', conclusion: 'success', startedAt: '2026-01-01T00:01:00Z', completedAt: '2026-01-01T00:02:00Z' },
    ],
  }
}

export const noneAuth: GitHubAuthAdapter = {
  kind: 'none',
  create: createFakeGitHub,
}

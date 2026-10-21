import type { Octokit } from '@octokit/rest'
import { installationIndex, type Installation } from '../installations'
import type { JobAnnotation } from '../../types'
import type { GitHubAuthAdapter, GitHubClient, JobDetails, QueuedJob, RepoInfo } from '../types'

/** In-memory stand-in for tests: deterministic answers, records every call, never talks to GitHub. */
export type FakeGitHub = GitHubClient & {
  calls: { method: string; args: unknown[] }[]
  queued: Map<string, QueuedJob[]>
  files: Map<string, string>
  deletedRunners: number[]
  /** GitHub runner ids `getRunner` reports as busy; every other id it answers as online and idle. */
  busyRunners: Set<number>
  /** `repo#githubJobId` → log text; a missing entry answers 404 like GitHub does before the log is ready. */
  jobLogs: Map<string, string>
  /** `repo#githubJobId` → job details; a missing entry answers a deterministic two-step job built from the log's timestamps. */
  jobDetails: Map<string, JobDetails>
  /** `repo#githubJobId` → the job's check-run annotations; a missing entry answers an empty list. */
  annotations: Map<string, JobAnnotation[]>
  /** Branches created by `createBranch` and not yet deleted (`repo:name`). */
  branches: Set<string>
  /** Method name → error message; the next call to that method throws it with `status: 403`. */
  failOn: Map<string, string>
  /** What `permissions()` reports as granted (empty = nothing known). */
  granted: Record<string, string>
  /** Installation id → repositories `listInstallationRepos(max, id)` answers. */
  reposByInstallation: Map<number, RepoInfo[]>
  /** With installations: `method repo → installation id` for every repo call, as the App picks its token. */
  installationCalls: string[]
  /** How often the installation list was fetched (cache misses and refreshes). */
  installationFetches: () => number
  /**
   * Turns the fake into a multi-installation App source: `installs` answers from `list` (mutable, so a test can add
   * an installation later), cached like the App's (TTL and miss refetch as given), `permissions()` reports each one.
   */
  useInstallations(list: Installation[], opts?: { defaultId?: number; ttlMs?: number; missRefetchMs?: number; now?: () => number }): void
}

export function createFakeGitHub(): FakeGitHub {
  const calls: FakeGitHub['calls'] = []
  const queued = new Map<string, QueuedJob[]>()
  const files = new Map<string, string>()
  const deletedRunners: number[] = []
  const busyRunners = new Set<number>()
  const jobLogs = new Map<string, string>()
  const jobDetails = new Map<string, JobDetails>()
  const annotations = new Map<string, JobAnnotation[]>()
  const branches = new Set<string>()
  const failOn = new Map<string, string>()
  const pulls = new Map<string, { url: string; state: string }>()
  const granted: Record<string, string> = {}
  const reposByInstallation = new Map<number, RepoInfo[]>()
  let installationList: Installation[] | undefined
  let fetches = 0
  const installationCalls: string[] = []
  let nextRunnerId = 1000
  const rec = (method: string, ...args: unknown[]) => calls.push({ method, args })
  /** The App's rule, faked: a repo call needs an installation on the repo's owner. */
  const via = async (self: GitHubClient, method: string, repo: string) => {
    if (!self.installs) return
    const owner = repo.split('/')[0]!
    const inst = await self.installs.forOwner(owner)
    if (!inst) throw Object.assign(new Error(`the GitHub App is not installed on ${owner}`), { status: 404 })
    installationCalls.push(`${method} ${repo} → ${inst.id}`)
  }
  return {
    kind: 'none',
    calls,
    queued,
    files,
    deletedRunners,
    busyRunners,
    jobLogs,
    jobDetails,
    annotations,
    branches,
    failOn,
    granted,
    reposByInstallation,
    installationCalls,
    installationFetches: () => fetches,
    useInstallations(list, opts = {}) {
      installationList = list
      this.installs = installationIndex(async () => {
        fetches++
        rec('listInstallations')
        if (failOn.has('listInstallations')) throw Object.assign(new Error(failOn.get('listInstallations')), { status: 502 })
        return installationList!.map((i) => ({ ...i }))
      }, opts)
    },
    async getInstallationOctokit(): Promise<Octokit> {
      throw new Error('GITHUB_AUTH=none has no Octokit')
    },
    async createJitConfig(input) {
      await via(this, 'createJitConfig', input.repo)
      rec('createJitConfig', input)
      return { runnerId: nextRunnerId++, encodedJitConfig: `fake-jit-${input.name}` }
    },
    async deleteRunner(repo, runnerId) {
      await via(this, 'deleteRunner', repo)
      rec('deleteRunner', repo, runnerId)
      deletedRunners.push(runnerId)
    },
    async getRunner(repo, runnerId) {
      await via(this, 'getRunner', repo)
      rec('getRunner', repo, runnerId)
      if (deletedRunners.includes(runnerId)) return null
      return { status: 'online', busy: busyRunners.has(runnerId) }
    },
    async listQueuedJobs(repo) {
      await via(this, 'listQueuedJobs', repo)
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
    async listInstallationRepos(max, installationId) {
      rec('listInstallationRepos', max, installationId)
      if (installationId !== undefined) return reposByInstallation.get(installationId) ?? []
      return [{ fullName: 'example/repo', isPrivate: false, defaultBranch: 'main' }]
    },
    async getRepo(fullName) {
      await via(this, 'getRepo', fullName)
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
      if (!this.installs) return { source: 'none', granted: { ...granted } }
      const list = await this.installs.list()
      return {
        source: 'none',
        granted: {},
        installationId: this.installs.defaultId,
        appSlug: 'fake-app',
        installations: list.map((i) => ({ id: i.id, account: i.account, accountType: i.accountType, granted: { ...i.permissions }, repoCount: reposByInstallation.get(i.id)?.length ?? 0 })),
      }
    },
    async getJobLog(repo, githubJobId) {
      await via(this, 'getJobLog', repo)
      rec('getJobLog', repo, githubJobId)
      const text = jobLogs.get(`${repo}#${githubJobId}`)
      if (text === undefined) throw Object.assign(new Error(`Not Found: log for job ${githubJobId}`), { status: 404 })
      return text
    },
    async getJob(repo, githubJobId) {
      await via(this, 'getJob', repo)
      rec('getJob', repo, githubJobId)
      if (failOn.has('getJob')) throw Object.assign(new Error(failOn.get('getJob')), { status: 403 })
      return jobDetails.get(`${repo}#${githubJobId}`) ?? fakeJobDetails()
    },
    async listJobAnnotations(repo, githubJobId, max = 50) {
      await via(this, 'listJobAnnotations', repo)
      rec('listJobAnnotations', repo, githubJobId)
      if (failOn.has('listJobAnnotations')) throw Object.assign(new Error(failOn.get('listJobAnnotations')), { status: 403 })
      return (annotations.get(`${repo}#${githubJobId}`) ?? []).slice(0, max)
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
    runnerName: null,
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

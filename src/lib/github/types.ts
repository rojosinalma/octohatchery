import type { Octokit } from '@octokit/rest'

export type QueuedJob = { githubJobId: number; runId: number; name: string; labels: string[]; htmlUrl: string; queuedAt: string }
export type JitConfig = { runnerId: number; encodedJitConfig: string }
export type RepoInfo = { fullName: string; isPrivate: boolean; defaultBranch: string }
export type FileContents = { content: string; sha: string }
export type WebhookResult = { id: number; created: boolean }

/** Everything the app asks of GitHub, behind one interface so `app` and `pat` (and `none` in tests) are interchangeable. */
export type GitHubClient = {
  kind: 'app' | 'pat' | 'none'
  getInstallationOctokit(repoFullName: string): Promise<Octokit>
  createJitConfig(input: { repo: string; name: string; labels: string[]; runnerGroupId?: number }): Promise<JitConfig>
  deleteRunner(repo: string, runnerId: number): Promise<void>
  /** Jobs of queued workflow runs with their labels (polling fallback). */
  listQueuedJobs(repo: string): Promise<QueuedJob[]>
  /** PAT: create or update the repo's `workflow_job` hook. App: no-op, the App delivers webhooks. */
  ensureWebhook(repo: string, url: string, secret: string): Promise<WebhookResult | null>
  deleteWebhook(repo: string, hookId: number): Promise<void>
  listInstallationRepos(): Promise<RepoInfo[]>
  getRepo(fullName: string): Promise<RepoInfo>
  getFileContents(repo: string, path: string, ref?: string): Promise<FileContents | null>
  putFile(repo: string, input: { path: string; content: string; message: string; sha?: string; branch: string }): Promise<{ commitSha: string }>
  createBranch(repo: string, name: string, fromBranch: string): Promise<void>
  openPullRequest(repo: string, input: { title: string; body: string; head: string; base: string }): Promise<{ url: string }>
  listWorkflowFiles(repo: string, ref?: string): Promise<string[]>
  /** Plain-text log of a finished job (follows GitHub's redirect). Throws with `status: 404` while the log is not ready. */
  getJobLog(repo: string, githubJobId: number): Promise<string>
}

export type GitHubAuthAdapter = {
  kind: GitHubClient['kind']
  create(): GitHubClient
}

export function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = fullName.split('/')
  if (!owner || !repo || rest.length) throw new Error(`repository must be "owner/name", got "${fullName}"`)
  return { owner, repo }
}

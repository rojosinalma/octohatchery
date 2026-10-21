import type { Octokit } from '@octokit/rest'
import type { JobAnnotation, JobStep } from '../types'
import type { InstallationSource } from './installations'
import type { PermissionReport } from './permissions'

export type QueuedJob = { githubJobId: number; runId: number; name: string; labels: string[]; htmlUrl: string; queuedAt: string }
export type JitConfig = { runnerId: number; encodedJitConfig: string }
export type RepoInfo = { fullName: string; isPrivate: boolean; defaultBranch: string }
export type FileContents = { content: string; sha: string }
export type WebhookResult = { id: number; created: boolean }
/** `GET /repos/{o}/{r}/actions/jobs/{id}`: the fields the orchestrator stores. */
export type JobDetails = { status: string; conclusion: string | null; startedAt: string | null; completedAt: string | null; steps: JobStep[] }

/** Everything the app asks of GitHub, behind one interface so `app` and `pat` (and `none` in tests) are interchangeable. */
export type GitHubClient = {
  kind: 'app' | 'pat' | 'none'
  /**
   * The App's installations (one per account it is installed on); every repo call uses the installation of the
   * repo's owner. Absent for sources that have no installations (a token serves its one account).
   */
  installs?: InstallationSource
  getInstallationOctokit(repoFullName: string): Promise<Octokit>
  createJitConfig(input: { repo: string; name: string; labels: string[]; runnerGroupId?: number }): Promise<JitConfig>
  deleteRunner(repo: string, runnerId: number): Promise<void>
  /** A registered runner's state on GitHub; null when GitHub no longer knows it. */
  getRunner(repo: string, runnerId: number): Promise<{ status: string; busy: boolean } | null>
  /** Jobs of queued workflow runs with their labels (polling fallback). */
  listQueuedJobs(repo: string): Promise<QueuedJob[]>
  /** PAT: create or update the repo's `workflow_job` hook. App: no-op, the App delivers webhooks. */
  ensureWebhook(repo: string, url: string, secret: string): Promise<WebhookResult | null>
  deleteWebhook(repo: string, hookId: number): Promise<void>
  /**
   * Repositories the token or one App installation can reach, at most `max` (the first pages). App: `installationId`
   * picks the installation (default: `GITHUB_APP_INSTALLATION_ID`, else the first one).
   */
  listInstallationRepos(max?: number, installationId?: number): Promise<RepoInfo[]>
  /**
   * What the credentials are allowed to do. App: every installation's accepted permissions and repository count. PAT: fine-grained tokens expose
   * no grant list, so cheap reads on `probeRepo` (when given) prove definite absence only.
   */
  permissions(probeRepo?: string): Promise<PermissionReport>
  getRepo(fullName: string): Promise<RepoInfo>
  getFileContents(repo: string, path: string, ref?: string): Promise<FileContents | null>
  putFile(repo: string, input: { path: string; content: string; message: string; sha?: string; branch: string }): Promise<{ commitSha: string; htmlUrl: string }>
  createBranch(repo: string, name: string, fromBranch: string): Promise<void>
  /** Deletes `refs/heads/<name>`; a branch that is already gone is not an error. */
  deleteBranch(repo: string, name: string): Promise<void>
  openPullRequest(repo: string, input: { title: string; body: string; head: string; base: string }): Promise<{ url: string; number: number }>
  /** Reads a pull request back; null when GitHub does not know it. */
  getPullRequest(repo: string, number: number): Promise<{ url: string; state: string } | null>
  listWorkflowFiles(repo: string, ref?: string): Promise<string[]>
  /** Plain-text log of a finished job (follows GitHub's redirect). Throws with `status: 404` while the log is not ready. */
  getJobLog(repo: string, githubJobId: number): Promise<string>
  /** Status, conclusion and steps (with GitHub's timestamps) of one job. */
  getJob(repo: string, githubJobId: number): Promise<JobDetails>
  /** Check-run annotations of a job (its check run id is the job id), at most `max`; schema-checked. */
  listJobAnnotations(repo: string, githubJobId: number, max?: number): Promise<JobAnnotation[]>
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

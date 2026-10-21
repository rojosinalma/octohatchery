import type { GitHubClient } from '../types'

const REASON = 'no GitHub credential yet: deliver one from Octoforge or set GITHUB_AUTH in .env'

/**
 * The client of a node that started without GitHub variables and waits for Octoforge: kind `none` like an
 * unconfigured node, but every call fails with the reason instead of answering like the test fake.
 */
export function unconfiguredGitHub(): GitHubClient {
  const refuse = async (): Promise<never> => {
    throw Object.assign(new Error(REASON), { status: 503 })
  }
  return {
    kind: 'none',
    getInstallationOctokit: refuse,
    createJitConfig: refuse,
    deleteRunner: refuse,
    getRunner: refuse,
    listQueuedJobs: refuse,
    ensureWebhook: refuse,
    deleteWebhook: refuse,
    listInstallationRepos: refuse,
    permissions: async () => ({ source: 'none', granted: {} }),
    getRepo: refuse,
    getFileContents: refuse,
    putFile: refuse,
    createBranch: refuse,
    deleteBranch: refuse,
    openPullRequest: refuse,
    getPullRequest: refuse,
    listWorkflowFiles: refuse,
    getJobLog: refuse,
    getJob: refuse,
    getRunAttemptLogs: refuse,
    listJobAnnotations: refuse,
  }
}

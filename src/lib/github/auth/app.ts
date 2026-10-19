import { App } from '@octokit/app'
import { Octokit } from '@octokit/rest'
import { config } from '../../config'
import { restClient } from '../rest'
import type { GitHubAuthAdapter, RepoInfo } from '../types'

/** GitHub App: installation tokens per call; webhooks are configured on the App itself. */
export const appAuth: GitHubAuthAdapter = {
  kind: 'app',
  create() {
    const cfg = config()
    const app = new App({ appId: cfg.githubAppId!, privateKey: cfg.githubAppPrivateKey!, Octokit })
    const installationId = Number(cfg.githubAppInstallationId)
    const getOctokit = () => app.getInstallationOctokit(installationId)
    return restClient('app', getOctokit, {
      async ensureWebhook() {
        return null // the App delivers workflow_job events for every installed repo
      },
      async deleteWebhook() {},
      async listInstallationRepos(): Promise<RepoInfo[]> {
        const o = await getOctokit()
        const repos = await o.paginate(o.rest.apps.listReposAccessibleToInstallation, { per_page: 100 })
        return repos.map((r) => ({ fullName: r.full_name, isPrivate: r.private, defaultBranch: r.default_branch }))
      },
    })
  },
}

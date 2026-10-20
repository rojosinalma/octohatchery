import { App } from '@octokit/app'
import { Octokit } from '@octokit/rest'
import { config } from '../../config'
import { log } from '../../log'
import type { PermissionReport } from '../permissions'
import { paginateUpTo, restClient } from '../rest'
import type { GitHubAuthAdapter, RepoInfo } from '../types'

const logger = log('github')
const DEFAULT_REPO_CAP = 500

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
      async listInstallationRepos(max = DEFAULT_REPO_CAP): Promise<RepoInfo[]> {
        const o = await getOctokit()
        const repos = await paginateUpTo(o.paginate.iterator(o.rest.apps.listReposAccessibleToInstallation, { per_page: 100 }), max)
        logger.info(`GET /installation/repositories: ${repos.length} repo(s)`)
        return repos.map((r) => ({ fullName: r.full_name, isPrivate: r.private, defaultBranch: r.default_branch }))
      },
      async permissions(): Promise<PermissionReport> {
        // App JWT: who the App is and what this installation accepted.
        const me = await app.octokit.request('GET /app')
        logger.info(`GET /app: ${me.data?.slug ?? '?'}`)
        const inst = await app.octokit.request('GET /app/installations/{installation_id}', { installation_id: installationId })
        const account = inst.data.account as { login?: string; type?: string } | null
        logger.info(`GET /app/installations/${installationId}: ${account?.login ?? '?'}`)
        const o = await getOctokit()
        const repos = await o.rest.apps.listReposAccessibleToInstallation({ per_page: 1 })
        logger.info(`GET /installation/repositories?per_page=1: total ${repos.data.total_count}`)
        return {
          source: 'app',
          granted: (inst.data.permissions ?? {}) as Record<string, string>,
          account: account?.login,
          accountType: account?.type,
          installationId,
          repoCount: repos.data.total_count,
          appSlug: me.data?.slug ?? undefined,
          appOwner: me.data?.owner ? { login: (me.data.owner as { login: string }).login, type: (me.data.owner as { type?: string }).type ?? 'User' } : undefined,
        }
      },
    })
  },
}

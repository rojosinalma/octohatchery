import { App } from '@octokit/app'
import { Octokit } from '@octokit/rest'
import { config } from '../../config'
import { log } from '../../log'
import { installationIndex, MAX_INSTALLATIONS, type Installation } from '../installations'
import type { InstallationReport, PermissionReport } from '../permissions'
import { githubMessage, paginateUpTo, restClient } from '../rest'
import { splitRepo, type GitHubAuthAdapter, type RepoInfo } from '../types'

const logger = log('github')
const DEFAULT_REPO_CAP = 500

/**
 * GitHub App: one App, installed on one or more accounts (a user, organisations). Every repo call uses an installation
 * token of the repo's owner, found in the cached `GET /app/installations`; webhooks are configured on the App itself.
 */
export const appAuth: GitHubAuthAdapter = {
  kind: 'app',
  create() {
    const cfg = config()
    const app = new App({ appId: cfg.githubAppId!, privateKey: cfg.githubAppPrivateKey!, Octokit })
    const defaultId = cfg.githubAppInstallationId ? Number(cfg.githubAppInstallationId) : undefined

    const installs = installationIndex(
      async (): Promise<Installation[]> => {
        const items = await paginateUpTo(app.octokit.paginate.iterator('GET /app/installations', { per_page: 100 }), MAX_INSTALLATIONS)
        const list = items.map((i) => {
          const account = i.account as { login?: string; slug?: string; type?: string } | null
          return { id: i.id, account: account?.login ?? account?.slug ?? `installation-${i.id}`, accountType: account?.type ?? (account?.slug ? 'Enterprise' : 'User'), permissions: (i.permissions ?? {}) as Record<string, string> }
        })
        logger.info(`GET /app/installations: ${list.map((i) => `${i.account}#${i.id}`).join(', ') || 'none'}`)
        return list
      },
      { defaultId },
    )

    /** Installation for an explicit id, the default one, or the first one GitHub lists. */
    const fallbackId = async (): Promise<number> => {
      if (defaultId !== undefined) return defaultId
      const first = (await installs.list())[0]
      if (!first) throw Object.assign(new Error('the GitHub App is installed on no account'), { status: 404 })
      return first.id
    }

    const octokitFor = async (repoFullName: string): Promise<Octokit> => {
      const { owner } = splitRepo(repoFullName)
      const inst = await installs.forOwner(owner)
      if (!inst) throw Object.assign(new Error(`the GitHub App is not installed on ${owner}`), { status: 404 })
      return (await app.getInstallationOctokit(inst.id)) as unknown as Octokit
    }

    return restClient('app', octokitFor, {
      installs,
      async ensureWebhook() {
        return null // the App delivers workflow_job events for every installed repo
      },
      async deleteWebhook() {},
      async listInstallationRepos(max = DEFAULT_REPO_CAP, installationId?: number): Promise<RepoInfo[]> {
        const id = installationId ?? (await fallbackId())
        const o = await app.getInstallationOctokit(id)
        const repos = await paginateUpTo(o.paginate.iterator(o.rest.apps.listReposAccessibleToInstallation, { per_page: 100 }), max)
        logger.info(`GET /installation/repositories (installation ${id}): ${repos.length} repo(s)`)
        return repos.map((r) => ({ fullName: r.full_name, isPrivate: r.private, defaultBranch: r.default_branch }))
      },
      async permissions(): Promise<PermissionReport> {
        // App JWT: who the App is and what each installation accepted; one cheap call per installation for its repo count.
        const me = await app.octokit.request('GET /app')
        logger.info(`GET /app: ${me.data?.slug ?? '?'}`)
        const list = await installs.list()
        const installations = await Promise.all(
          list.map(async (i): Promise<InstallationReport> => {
            const out: InstallationReport = { id: i.id, account: i.account, accountType: i.accountType, granted: i.permissions }
            try {
              const o = await app.getInstallationOctokit(i.id)
              const repos = await o.rest.apps.listReposAccessibleToInstallation({ per_page: 1 })
              logger.info(`GET /installation/repositories?per_page=1 (${i.account}#${i.id}): total ${repos.data.total_count}`)
              out.repoCount = repos.data.total_count
            } catch (err) {
              logger.warn(`repo count for ${i.account}#${i.id} failed`, githubMessage(err))
            }
            return out
          }),
        )
        return {
          source: 'app',
          granted: {},
          installationId: defaultId,
          installations,
          appSlug: me.data?.slug ?? undefined,
          appOwner: me.data?.owner ? { login: (me.data.owner as { login: string }).login, type: (me.data.owner as { type?: string }).type ?? 'User' } : undefined,
        }
      },
    })
  },
}

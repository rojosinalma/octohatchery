import { Octokit } from '@octokit/rest'
import { config } from '../../config'
import { log } from '../../log'
import type { PermissionReport } from '../permissions'
import { paginateUpTo, probeTokenPermissions, restClient } from '../rest'
import { splitRepo, type GitHubAuthAdapter, type RepoInfo } from '../types'

const logger = log('github')
const DEFAULT_REPO_CAP = 500

/** Personal access token: one client for everything; repo webhooks are created per adopted repo. */
export const patAuth: GitHubAuthAdapter = {
  kind: 'pat',
  create() {
    const octokit = new Octokit({ auth: config().githubToken })
    const getOctokit = async () => octokit
    return restClient('pat', getOctokit, {
      async ensureWebhook(fullName, url, secret) {
        const { owner, repo } = splitRepo(fullName)
        const hooks = await octokit.rest.repos.listWebhooks({ owner, repo, per_page: 100 })
        const existing = hooks.data.find((h) => h.config?.url === url)
        const hookConfig = { url, content_type: 'json', secret, insecure_ssl: '0' }
        if (existing) {
          await octokit.rest.repos.updateWebhook({ owner, repo, hook_id: existing.id, config: hookConfig, events: ['workflow_job'], active: true })
          logger.info(`PATCH ${fullName} webhook ${existing.id}: ok`)
          return { id: existing.id, created: false }
        }
        const created = await octokit.rest.repos.createWebhook({ owner, repo, config: hookConfig, events: ['workflow_job'], active: true })
        logger.info(`POST ${fullName} webhook ${created.data.id}: ok`)
        return { id: created.data.id, created: true }
      },
      async deleteWebhook(fullName, hookId) {
        const { owner, repo } = splitRepo(fullName)
        try {
          await octokit.rest.repos.deleteWebhook({ owner, repo, hook_id: hookId })
          logger.info(`DELETE ${fullName} webhook ${hookId}: ok`)
        } catch (err) {
          if ((err as { status?: number }).status !== 404) throw err
        }
      },
      async listInstallationRepos(max = DEFAULT_REPO_CAP): Promise<RepoInfo[]> {
        const repos = await paginateUpTo(octokit.paginate.iterator(octokit.rest.repos.listForAuthenticatedUser, { per_page: 100, affiliation: 'owner,collaborator,organization_member' }), max)
        logger.info(`GET /user/repos: ${repos.length} repo(s)`)
        return repos.map((r) => ({ fullName: r.full_name, isPrivate: r.private, defaultBranch: r.default_branch }))
      },
      async permissions(probeRepo): Promise<PermissionReport> {
        return { source: 'pat', ...(await probeTokenPermissions(octokit, probeRepo)) }
      },
    })
  },
}

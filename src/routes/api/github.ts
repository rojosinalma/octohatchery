import { Elysia } from 'elysia'
import { jsonOk } from '../../lib/json'
import { service } from '../../lib/service'
import { actorOf } from './actor'

/** GitHub credentials: granted versus required permissions, and the repositories they can reach. */
export const githubRoutes = new Elysia({ prefix: '/github' })
  .get('/status', async () => jsonOk({ status: await service.githubStatus() }))
  .post('/recheck', async ({ headers }) => {
    const status = await service.recheckGitHub(actorOf(headers))
    return jsonOk({ status }, status.ok ? 'GitHub access checked: nothing missing' : status.error ? `GitHub check failed: ${status.error}` : `GitHub access lacks ${status.missing.join(', ') || 'a configured source'}`)
  })
  .get('/repos', async () => {
    const [repos, status] = await Promise.all([service.listGitHubRepos(), service.githubStatus()])
    return jsonOk({ repos, source: status.source, installUrl: status.installUrl }, `${repos.length} repositories`)
  })

import { Elysia, t } from 'elysia'
import { jsonOk } from '../../lib/json'
import { service } from '../../lib/service'
import { actorOf } from './actor'

const RepoBody = t.Object({ fullName: t.String({ minLength: 3, maxLength: 200 }) })

export const RunsOnBody = t.Object({
  fullName: t.String({ minLength: 3, maxLength: 200 }),
  mode: t.Union([t.Literal('snippet'), t.Literal('pr'), t.Literal('commit')]),
  type: t.String({ minLength: 1 }),
  host: t.Optional(t.String({ minLength: 1 })),
  workflows: t.Optional(t.Array(t.String(), { maxItems: 100 })),
})

export const repos = new Elysia({ prefix: '/repos' })
  .get('/', async () => jsonOk({ repos: await service.listRepos() }))
  .post(
    '/adopt',
    async ({ body, headers }) => {
      const repo = await service.adoptRepo(body.fullName, actorOf(headers))
      return jsonOk({ repo }, `${repo.fullName} adopted`)
    },
    { body: RepoBody },
  )
  .post(
    '/unadopt',
    async ({ body, headers }) => {
      await service.unadoptRepo(body.fullName, actorOf(headers))
      return jsonOk({}, `${body.fullName} released`)
    },
    { body: RepoBody },
  )
  .post(
    '/runs-on',
    async ({ body, headers, set }) => {
      const result = await service.applyRunsOn(body, actorOf(headers))
      if (!result.ok) set.status = 422
      return { ...result, code: result.ok ? undefined : 'unchanged' }
    },
    { body: RunsOnBody },
  )

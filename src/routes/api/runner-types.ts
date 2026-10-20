import { Elysia, t } from 'elysia'
import { jsonOk } from '../../lib/json'
import { service } from '../../lib/service'
import { actorOf } from './actor'

const Name = t.Object({ name: t.String({ minLength: 1, maxLength: 63 }) })

export const RunnerTypeBody = t.Object({
  description: t.Optional(t.Nullable(t.String({ maxLength: 500 }))),
  labels: t.Optional(t.Array(t.String(), { maxItems: 20 })),
  image: t.String({ minLength: 1 }),
  cpus: t.Number({ exclusiveMinimum: 0 }),
  memoryMb: t.Integer({ minimum: 128 }),
  mounts: t.Optional(t.Array(t.String(), { maxItems: 20 })),
  env: t.Optional(t.Record(t.String(), t.String())),
  secretEnv: t.Optional(t.Array(t.String(), { maxItems: 50 })),
  /** Docker access: none (default), socket (host daemon) or dind (private daemon sidecar). */
  docker: t.Optional(t.Union([t.Literal('none'), t.Literal('socket'), t.Literal('dind')])),
})

export const runnerTypes = new Elysia({ prefix: '/runner-types' })
  .get('/', async () => jsonOk({ runnerTypes: await service.listRunnerTypes() }))
  .get('/:name', async ({ params }) => jsonOk({ runnerType: await service.getRunnerType(params.name) }), { params: Name })
  .put(
    '/:name',
    async ({ params, body, headers }) => {
      const runnerType = await service.upsertRunnerType(
        {
          name: params.name,
          description: body.description ?? null,
          labels: body.labels ?? [],
          image: body.image,
          cpus: body.cpus,
          memoryMb: body.memoryMb,
          mounts: body.mounts ?? [],
          env: body.env ?? {},
          secretEnv: body.secretEnv ?? [],
          docker: body.docker ?? 'none',
        },
        actorOf(headers),
      )
      return jsonOk({ runnerType }, `runner type ${runnerType.name} saved`)
    },
    { params: Name, body: RunnerTypeBody },
  )
  .delete(
    '/:name',
    async ({ params, headers }) => {
      await service.deleteRunnerType(params.name, actorOf(headers))
      return jsonOk({}, `runner type ${params.name} deleted`)
    },
    { params: Name },
  )

import { Elysia, t } from 'elysia'
import { jsonOk } from '../../lib/json'
import { service } from '../../lib/service'
import { actorOf } from './actor'

export const RunnerStateSchema = t.Union([
  t.Literal('spawning'),
  t.Literal('idle'),
  t.Literal('busy'),
  t.Literal('exited'),
  t.Literal('failed'),
  t.Literal('removed'),
])

export const runners = new Elysia({ prefix: '/runners' })
  .get('/', async ({ query }) => jsonOk({ runners: await service.listRunners(query) }), {
    query: t.Object({
      host: t.Optional(t.String()),
      state: t.Optional(RunnerStateSchema),
      limit: t.Optional(t.Integer({ minimum: 1, maximum: 1000 })),
    }),
  })
  .post(
    '/spawn',
    async ({ body, headers }) => {
      const runner = await service.spawn(body, actorOf(headers))
      return jsonOk({ runner }, `runner ${runner.name} ${runner.state}`)
    },
    { body: t.Object({ type: t.String({ minLength: 1 }), host: t.String({ minLength: 1 }) }) },
  )
  .delete(
    '/:id',
    async ({ params, headers }) => {
      await service.kill(params.id, actorOf(headers))
      return jsonOk({}, `runner ${params.id} removed`)
    },
    { params: t.Object({ id: t.Integer({ minimum: 1 }) }) },
  )

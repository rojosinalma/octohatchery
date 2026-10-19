import { Elysia, t } from 'elysia'
import { jsonOk } from '../../lib/json'
import { service } from '../../lib/service'

export const events = new Elysia({ prefix: '/events' }).get('/', async ({ query }) => jsonOk({ events: await service.listEvents(query) }), {
  query: t.Object({ limit: t.Optional(t.Integer({ minimum: 1, maximum: 1000 })) }),
})

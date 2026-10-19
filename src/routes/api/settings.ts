import { Elysia, t } from 'elysia'
import { jsonOk } from '../../lib/json'
import { service } from '../../lib/service'
import { actorOf } from './actor'

export const settingsRoutes = new Elysia({ prefix: '/settings' })
  .get('/', async () => jsonOk({ settings: await service.getSettings() }))
  .put(
    '/:key',
    async ({ params, body, headers }) => {
      await service.setSetting(params.key, body.value, actorOf(headers))
      return jsonOk({ key: params.key, value: body.value }, `${params.key} set to ${body.value}`)
    },
    { params: t.Object({ key: t.String({ minLength: 1, maxLength: 64 }) }), body: t.Object({ value: t.String({ maxLength: 500 }) }) },
  )

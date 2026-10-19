import { Elysia, t } from 'elysia'
import { jsonOk } from '../../lib/json'
import { service } from '../../lib/service'
import { actorOf } from './actor'

export const SlotBody = t.Object({
  host: t.String({ minLength: 1 }),
  type: t.String({ minLength: 1 }),
  count: t.Integer({ minimum: 0, maximum: 1000 }),
})

export const slots = new Elysia({ prefix: '/slots' })
  .get('/', async () => jsonOk({ slots: await service.listSlots() }))
  .put(
    '/',
    async ({ body, headers }) => {
      const slot = await service.setSlots(body, actorOf(headers))
      return jsonOk({ slot }, `${slot.count} ${slot.type} slot(s) on ${slot.host}`)
    },
    { body: SlotBody },
  )

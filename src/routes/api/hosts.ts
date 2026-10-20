import { Elysia, t } from 'elysia'
import { jsonOk } from '../../lib/json'
import { service } from '../../lib/service'
import { actorOf } from './actor'

const nameParams = t.Object({ name: t.String({ minLength: 1, maxLength: 63 }) })

export const hosts = new Elysia({ prefix: '/hosts' })
  .get('/', async () => jsonOk({ hosts: await service.listHosts() }))
  /** The images this host holds, out of the references the instance wants. */
  .get(
    '/:name/images',
    async ({ params }) => {
      const inv = await service.listImages()
      return jsonOk({ references: inv.references, images: inv.images.filter((i) => i.host === params.name), pulls: inv.pulls.filter((p) => p.host === params.name) })
    },
    { params: nameParams },
  )
  /** Queues a pull on that host; its node runs it and the outcome arrives as an `image` event. */
  .post(
    '/:name/images/pull',
    async ({ params, body, headers }) => {
      const { reused, ...pull } = await service.pullImage({ host: params.name, reference: body.reference }, actorOf(headers))
      return jsonOk({ pull }, reused ? `pull of ${pull.reference} already ${pull.status} on ${pull.host}` : `pull of ${pull.reference} queued on ${pull.host}`)
    },
    { params: nameParams, body: t.Object({ reference: t.String({ minLength: 1, maxLength: 300 }) }) },
  )

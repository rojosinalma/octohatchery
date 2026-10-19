import { Elysia } from 'elysia'
import { jsonOk } from '../../lib/json'
import { service } from '../../lib/service'

export const hosts = new Elysia({ prefix: '/hosts' }).get('/', async () => jsonOk({ hosts: await service.listHosts() }))

import { Elysia } from 'elysia'
import { jsonOk } from '../../lib/json'
import { service } from '../../lib/service'

/** The image matrix behind Templates → Images: wanted references × hosts, with the newest pull per cell. */
export const images = new Elysia({ prefix: '/images' }).get('/', async () => jsonOk(await service.listImages()))

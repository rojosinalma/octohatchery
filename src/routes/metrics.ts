import { Elysia } from 'elysia'
import { metrics as m } from '../lib/metrics'

/** Prometheus text exposition; gauges are refreshed from the database on each scrape. */
export const metrics = new Elysia({ name: 'metrics' }).get('/metrics', async ({ set }) => {
  set.headers['content-type'] = m.registry.contentType
  return m.registry.metrics()
})

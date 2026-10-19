import { Elysia, t } from 'elysia'
import { jsonOk } from '../../lib/json'
import { service } from '../../lib/service'

export const JobStatusSchema = t.Union([t.Literal('queued'), t.Literal('claimed'), t.Literal('in_progress'), t.Literal('completed'), t.Literal('ignored')])

export const jobs = new Elysia({ prefix: '/jobs' }).get('/', async ({ query }) => jsonOk({ jobs: await service.listJobs(query) }), {
  query: t.Object({
    repo: t.Optional(t.String()),
    status: t.Optional(JobStatusSchema),
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 1000 })),
  }),
})

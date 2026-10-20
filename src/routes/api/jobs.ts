import { Elysia, t } from 'elysia'
import { bus, type LogEvent } from '../../lib/bus'
import { jsonOk } from '../../lib/json'
import { service } from '../../lib/service'
import { JOBS_PER_PAGE } from '../../lib/types'
import type { JobLog } from '../../lib/types'
import { sseResponse } from '../sse'

export const JobStatusSchema = t.Union([t.Literal('queued'), t.Literal('claimed'), t.Literal('in_progress'), t.Literal('completed'), t.Literal('ignored')])

const idParams = t.Object({ id: t.Integer({ minimum: 1 }) })
/** Lines appended by another node reach this one through the database; the stream re-reads it at this pace. */
const LOG_POLL_MS = 2_000
const LOG_PAGE = 5000

export const jobs = new Elysia({ prefix: '/jobs' })
  /** Paged when `per` is given (`page` defaults to 1); otherwise the first `limit` rows. `total` always counts the whole filter. */
  .get(
    '/',
    async ({ query }) => {
      const per = query.per === undefined ? undefined : Number(query.per)
      const filter = { ...query, per, running: query.running === true, failed: query.failed === true }
      const [jobs, total] = await Promise.all([service.listJobs(filter), service.countJobs(filter)])
      return jsonOk({ jobs, total, page: per === undefined ? 1 : (filter.page ?? 1), per: per ?? jobs.length })
    },
    {
      query: t.Object({
        repo: t.Optional(t.String({ maxLength: 200 })),
        status: t.Optional(JobStatusSchema),
        q: t.Optional(t.String({ maxLength: 200 })),
        since: t.Optional(t.String({ format: 'date-time' })),
        running: t.Optional(t.Boolean()),
        failed: t.Optional(t.Boolean()),
        runner: t.Optional(t.String({ maxLength: 200 })),
        limit: t.Optional(t.Integer({ minimum: 1, maximum: 1000 })),
        page: t.Optional(t.Integer({ minimum: 1 })),
        // Query values arrive as strings; the literal union keeps the accepted sizes in the schema.
        per: t.Optional(t.Union(JOBS_PER_PAGE.map((n) => t.Literal(String(n))))),
      }),
    },
  )

  .get('/:id', async ({ params }) => jsonOk({ job: await service.getJob(params.id) }), { params: idParams })

  .get('/:id/log', async ({ params, query }) => jsonOk(await service.getJobLog(params.id, query)), {
    params: idParams,
    query: t.Object({
      after: t.Optional(t.Integer({ minimum: 0 })),
      limit: t.Optional(t.Integer({ minimum: 1, maximum: 20_000 })),
    }),
  })

  /**
   * SSE: stored lines after `after` first, then every new batch as `event: line` (`{lines}`), and
   * `event: end` (`{source, truncated, replaced}`) once the log is complete. Lines written on another
   * node arrive through a database poll; lines written here arrive from the bus as well.
   */
  .get(
    '/:id/log/stream',
    async ({ params, query, request, set }) => {
      const id = params.id
      let last = query.after ?? 0
      let first: JobLog | undefined = await service.getJobLog(id, { after: last, limit: LOG_PAGE }) // 404 before the stream opens
      return sseResponse(request, set, ({ send, touch, close }) => {
        let busy = false
        let stopped = false
        const emit = (lines: LogEvent['lines']) => {
          const fresh = lines.filter((l) => l.seq > last)
          if (!fresh.length) return
          last = fresh[fresh.length - 1]!.seq
          send('line', JSON.stringify({ lines: fresh }))
          touch()
        }
        const finish = (info: { source: unknown; truncated: boolean; replaced?: boolean }) => {
          if (stopped) return
          stopped = true
          send('end', JSON.stringify({ source: info.source, truncated: info.truncated, replaced: info.replaced ?? false }))
          close()
        }
        const sync = async (replaced?: boolean) => {
          if (busy || stopped) return
          busy = true
          try {
            let page = first ?? (await service.getJobLog(id, { after: last, limit: LOG_PAGE }))
            first = undefined
            emit(page.lines)
            while (page.lines.length >= LOG_PAGE && !stopped) {
              page = await service.getJobLog(id, { after: last, limit: LOG_PAGE })
              emit(page.lines)
            }
            if (page.complete) finish({ ...page, replaced })
          } catch {
            finish({ source: null, truncated: false })
          } finally {
            busy = false
          }
        }
        const onLog = (ev: LogEvent) => {
          if (ev.jobId !== id || stopped) return
          if (ev.done) void sync(ev.replaced)
          else emit(ev.lines)
        }
        bus.on('log', onLog)
        const poll = setInterval(() => void sync(), LOG_POLL_MS)
        void sync()
        return () => {
          stopped = true
          bus.off('log', onLog)
          clearInterval(poll)
        }
      })
    },
    { params: idParams, query: t.Object({ after: t.Optional(t.Integer({ minimum: 0 })) }) },
  )

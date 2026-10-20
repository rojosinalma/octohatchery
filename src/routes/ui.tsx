import { Elysia, t } from 'elysia'
import { html } from '@elysiajs/html'
import { resolve, sep } from 'node:path'
import { service } from '../lib/service'
import { STATUS_BY_CODE } from '../lib/json'
import { ServiceError, type JobStatus } from '../lib/types'
import { Layout, type NavKey, type Theme } from '../views/layout'
import { OverviewLive, OverviewPage } from '../views/overview'
import { JOB_STATUSES, JobsPage, JobsTable } from '../views/jobs'
import { JobPage, LOG_DOM_LINES } from '../views/job'
import { ReposPage } from '../views/repos'
import { RunnerTypesPage } from '../views/runner-types'
import { EventsPage, EventsTable } from '../views/events'
import { SettingsPage, SettingsSide } from '../views/settings'

const publicDir = resolve(import.meta.dir, '../../public')
const tailorHeadFile = Bun.file(resolve(publicDir, 'tailor/tailor-head.html'))
const tailorHead = (await tailorHeadFile.exists()) ? await tailorHeadFile.text() : '<!-- run `tailor apply` to vendor the design system -->'

/** Version from the health snapshot, fetched once; "dev" when the snapshot is unavailable. */
let cachedVersion: string | null = null
const version = async () => {
  if (cachedVersion) return cachedVersion
  try {
    cachedVersion = (await service.health()).version || 'dev'
  } catch {
    return 'dev'
  }
  return cachedVersion
}

const theme = (settings: Record<string, string>): Theme => ({ skin: settings['ui_skin'], palette: settings['ui_palette'], mode: settings['ui_mode'] })

const page = async (active: NavKey, title: string, body: JSX.Element, side?: JSX.Element) => {
  const [v, settings] = await Promise.all([version(), service.getSettings().catch(() => ({}) as Record<string, string>)])
  return <Layout title={title} active={active} tailorHead={tailorHead} version={v} theme={theme(settings)} side={side}>{body}</Layout>
}

/** Serve one file from `public/`; `rel` is the raw wildcard. Anything that resolves outside `public/` is a 404. */
const notFound = () => new Response('Not found', { status: 404 })
const serveStatic = async (rel: string): Promise<Response> => {
  let decoded: string
  try {
    decoded = decodeURIComponent(rel)
  } catch {
    return new Response('Bad path', { status: 400 })
  }
  if (decoded.includes('\0') || decoded.split(/[\\/]+/).some((seg) => seg === '..')) return notFound()
  const full = resolve(publicDir, decoded)
  if (!full.startsWith(publicDir + sep)) return notFound()
  const file = Bun.file(full)
  if (!(await file.exists())) return notFound()
  const cache = full.includes(`${sep}tailor${sep}`) ? 'public, max-age=3600' : 'public, max-age=300'
  return new Response(file, { headers: { 'cache-control': cache } })
}

const partialQuery = t.Object({ partial: t.Optional(t.String()) })

export const ui = new Elysia({ name: 'ui' })
  .use(html())
  // A facade error on a page (unknown job id) becomes a plain status with the reason instead of a 500.
  .onError({ as: 'scoped' }, ({ error, code, set }) => {
    if (error instanceof ServiceError) {
      set.status = STATUS_BY_CODE[error.code] ?? 400
      return error.message
    }
    if (code === 'VALIDATION') {
      set.status = 400
      return error.message.split('\n')[0] ?? 'invalid request'
    }
  })
  .get('/public/*', ({ params }) => serveStatic(params['*']))
  .get('/tailor/*', ({ params }) => serveStatic(`tailor/${params['*']}`))
  .get('/favicon.svg', () => serveStatic('favicon.svg'))

  .get(
    '/',
    async ({ query }) => {
      const [hosts, slots, runners] = await Promise.all([service.listHosts(), service.listSlots(), service.listRunners({ limit: 200 })])
      const data = { hosts, slots, runners }
      if (query.partial) return <OverviewLive {...data} />
      return page('overview', 'Overview', <OverviewPage {...data} />)
    },
    { query: partialQuery },
  )

  .get(
    '/jobs',
    async ({ query }) => {
      const status = JOB_STATUSES.includes(query.status as JobStatus) ? (query.status as JobStatus) : undefined
      const filter = { repo: query.repo || undefined, status }
      const [jobs, repos] = await Promise.all([service.listJobs({ ...filter, limit: 200 }), query.partial ? Promise.resolve([]) : service.listRepos()])
      if (query.partial) return <JobsTable jobs={jobs} filter={filter} />
      return page('jobs', 'Jobs', <JobsPage jobs={jobs} repos={repos} filter={filter} />)
    },
    { query: t.Object({ partial: t.Optional(t.String()), repo: t.Optional(t.String()), status: t.Optional(t.String()), job: t.Optional(t.String()) }) },
  )

  .get(
    '/jobs/:id',
    async ({ params }) => {
      const job = await service.getJob(params.id)
      const [runner, log] = await Promise.all([
        job.runnerId === null ? Promise.resolve(null) : service.getRunner(job.runnerId).catch(() => null),
        service.getJobLog(params.id, { tail: LOG_DOM_LINES }),
      ])
      return page('jobs', job.name, <JobPage job={job} runner={runner} log={log} />)
    },
    { params: t.Object({ id: t.Integer({ minimum: 1 }) }) },
  )

  .get('/repos', async () => {
    const [repos, types] = await Promise.all([service.listRepos(), service.listRunnerTypes()])
    return page('repos', 'Repos', <ReposPage repos={repos} types={types} />)
  })

  .get('/runner-types', async () => {
    const [types, hosts, slots] = await Promise.all([service.listRunnerTypes(), service.listHosts(), service.listSlots()])
    return page('runner-types', 'Runner types', <RunnerTypesPage types={types} hosts={hosts} slots={slots} />)
  })

  .get(
    '/events',
    async ({ query }) => {
      const events = await service.listEvents({ limit: 500 })
      if (query.partial) return <EventsTable events={events} />
      return page('events', 'Events', <EventsPage events={events} />)
    },
    { query: partialQuery },
  )

  .get('/settings', async () => {
    const [settings, v] = await Promise.all([service.getSettings(), version()])
    return page('settings', 'Settings', <SettingsPage settings={settings} version={v} />, <SettingsSide />)
  })

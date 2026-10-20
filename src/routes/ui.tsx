import { Elysia, t } from 'elysia'
import { html } from '@elysiajs/html'
import { resolve, sep } from 'node:path'
import { service } from '../lib/service'
import { SETTING_DEFAULTS } from '../lib/settings'
import { STATUS_BY_CODE, validationMessage } from '../lib/json'
import { JOBS_PER_MAX, JOBS_PER_PAGE, ServiceError, type JobStatus } from '../lib/types'
import { Layout, type NavKey, type Theme } from '../views/layout'
import { OverviewLive, OverviewPage, RecentJobs } from '../views/overview'
import { JOB_STATUSES, JobsLive, JobsPage, type JobsFilter } from '../views/jobs'
import { JOBS_SCOPE, RECENT_SCOPE, type JobsScope, type JobsView } from '../views/jobs-table'
import { JobLive, JobPage, LOG_DOM_LINES } from '../views/job'
import { ReposPage } from '../views/repos'
import { RunnerTypesPage, SlotsMatrix } from '../views/runner-types'
import { ImagesLive, ImagesPage } from '../views/images'
import { HostsPage } from '../views/hosts'
import { EventsPage, EventsTable } from '../views/events'
import { SettingsPage, SettingsSide, otherKeys } from '../views/settings'

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
  const [v, settings, github] = await Promise.all([
    version(),
    service.getSettings().catch(() => ({}) as Record<string, string>),
    // The banner must never block a page: an unreachable GitHub renders no banner.
    service.githubStatus().catch(() => undefined),
  ])
  return (
    <Layout title={title} active={active} tailorHead={tailorHead} version={v} theme={theme(settings)} side={side} github={github}>
      {body}
    </Layout>
  )
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

/** Query schema of a jobs list under `prefix` (`''` on `/jobs`, `j_` on the Overview). Unknown values are ignored by `jobsView`. */
const jobsQuerySchema = (prefix: string) =>
  Object.fromEntries(
    Object.entries({
      repo: t.Optional(t.String({ maxLength: 200 })),
      status: t.Optional(t.String({ maxLength: 20 })),
      q: t.Optional(t.String({ maxLength: 200 })),
      since: t.Optional(t.String({ maxLength: 40 })),
      running: t.Optional(t.String({ maxLength: 1 })),
      failed: t.Optional(t.String({ maxLength: 1 })),
      runner: t.Optional(t.String({ maxLength: 200 })),
      page: t.Optional(t.String({ maxLength: 6 })),
      per: t.Optional(t.String({ maxLength: 3 })),
    }).map(([k, v]) => [prefix + k, v]),
  )

/** Reads the filter and paging of one list from the query and fetches its page and total. */
const jobsView = async (query: Record<string, string | undefined>, scope: JobsScope): Promise<JobsView> => {
  const get = (k: string) => query[scope.prefix + k]
  const status = JOB_STATUSES.includes(get('status') as JobStatus) ? (get('status') as JobStatus) : undefined
  const sinceRaw = get('since')
  const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? new Date(Date.parse(sinceRaw)).toISOString() : undefined
  const filter: JobsFilter = {
    repo: get('repo') || undefined,
    status,
    q: get('q')?.trim() || undefined,
    since,
    running: get('running') === '1' || undefined,
    failed: get('failed') === '1' || undefined,
    runner: get('runner')?.trim() || undefined,
  }
  const perParam = get('per')
  const perRaw = perParam === 'all' ? JOBS_PER_MAX : Number(perParam)
  const per = (JOBS_PER_PAGE as readonly number[]).includes(perRaw) ? perRaw : scope.per
  const pageRaw = Number(get('page'))
  const total = await service.countJobs(filter)
  // A page past the end lands on the last one, so a stale link still shows jobs.
  const page = Math.min(Math.max(1, Number.isInteger(pageRaw) ? pageRaw : 1), Math.max(1, Math.ceil(total / per)))
  const [jobs, runners] = await Promise.all([service.listJobs({ ...filter, page, per }), service.listRunners({ limit: 1000 })])
  const runnerNames = Object.fromEntries(runners.map((r) => [r.id, r.name]))
  return { jobs, filter, page, per, total, runnerNames }
}

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
      return validationMessage(error)
    }
  })
  .get('/public/*', ({ params }) => serveStatic(params['*']))
  .get('/tailor/*', ({ params }) => serveStatic(`tailor/${params['*']}`))
  .get('/favicon.svg', () => serveStatic('favicon.svg'))

  .get(
    '/',
    async ({ query }) => {
      if (query.partial === 'jobs') {
        const [view, repos] = await Promise.all([jobsView(query, RECENT_SCOPE), service.listRepos()])
        return <RecentJobs {...view} repos={repos} />
      }
      const [hosts, slots, runners] = await Promise.all([service.listHosts(), service.listSlots(), service.listRunners({ limit: 200 })])
      const data = { hosts, slots, runners }
      if (query.partial) return <OverviewLive {...data} />
      const [view, repos] = await Promise.all([jobsView(query, RECENT_SCOPE), service.listRepos()])
      return page('overview', 'Overview', <OverviewPage {...data} recent={{ ...view, repos }} />)
    },
    { query: t.Object({ partial: t.Optional(t.String()), ...jobsQuerySchema(RECENT_SCOPE.prefix) }) },
  )

  .get(
    '/jobs',
    async ({ query }) => {
      const [view, repos] = await Promise.all([jobsView(query, JOBS_SCOPE), service.listRepos()])
      if (query.partial) return <JobsLive {...view} repos={repos} />
      return page('jobs', 'Jobs', <JobsPage {...view} repos={repos} />)
    },
    { query: t.Object({ partial: t.Optional(t.String()), job: t.Optional(t.String()), ...jobsQuerySchema(JOBS_SCOPE.prefix) }) },
  )

  .get(
    '/jobs/:id',
    async ({ params, query }) => {
      const job = await service.getJob(params.id)
      const [runner, log] = await Promise.all([
        job.runnerId === null ? Promise.resolve(null) : service.getRunner(job.runnerId).catch(() => null),
        service.getJobLog(params.id, { tail: LOG_DOM_LINES }),
      ])
      if (query.partial === 'log') return <JobLive job={job} log={log} />
      return page('jobs', job.name, <JobPage job={job} runner={runner} log={log} raw={query.raw === '1'} />)
    },
    { params: t.Object({ id: t.Integer({ minimum: 1 }) }), query: t.Object({ raw: t.Optional(t.String({ maxLength: 1 })), partial: t.Optional(t.String()) }) },
  )

  .get('/repos', async () => {
    const [repos, types] = await Promise.all([service.listRepos(), service.listRunnerTypes()])
    return page('repos', 'Repos', <ReposPage repos={repos} types={types} githubAuth={service.githubAuthKind()} />)
  })

  .get(
    '/templates',
    async ({ query }) => {
      const [types, hosts, slots] = await Promise.all([service.listRunnerTypes(), service.listHosts(), service.listSlots()])
      if (query.partial) return <SlotsMatrix types={types} hosts={hosts} slots={slots} />
      const [settings, inventory] = await Promise.all([service.getSettings().catch(() => ({}) as Record<string, string>), service.listImages()])
      const imageDefault = settings['runner_image_default'] || SETTING_DEFAULTS['runner_image_default']!
      return page('templates', 'Templates', <RunnerTypesPage types={types} hosts={hosts} slots={slots} imageDefault={imageDefault} images={inventory.images} />)
    },
    { query: partialQuery },
  )

  .get(
    '/templates/images',
    async ({ query }) => {
      const inventory = await service.listImages()
      if (query.partial) return <ImagesLive {...inventory} />
      return page('templates', 'Images', <ImagesPage {...inventory} />)
    },
    { query: partialQuery },
  )

  // The page was `/runner-types` before the dashboard called them templates; the API path keeps the old name.
  .get('/runner-types', ({ redirect }) => redirect('/templates', 301))

  .get('/hosts', async () => {
    const [hosts, slots] = await Promise.all([service.listHosts(), service.listSlots()])
    return page('hosts', 'Hosts', <HostsPage hosts={hosts} slots={slots} />)
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
    const [settings, v, github] = await Promise.all([service.getSettings(), version(), service.githubStatus()])
    return page('settings', 'Settings', <SettingsPage settings={settings} version={v} github={github} />, <SettingsSide hasOther={otherKeys(settings).length > 0} />)
  })

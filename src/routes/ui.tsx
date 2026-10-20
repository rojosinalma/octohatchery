import { Elysia, t } from 'elysia'
import { html } from '@elysiajs/html'
import { resolve, sep } from 'node:path'
import { service } from '../lib/service'
import { SETTING_DEFAULTS } from '../lib/settings'
import { STATUS_BY_CODE } from '../lib/json'
import { ServiceError, type JobStatus } from '../lib/types'
import { Layout, type NavKey, type Theme } from '../views/layout'
import { OverviewLive, OverviewPage } from '../views/overview'
import { JOB_STATUSES, JobsPage, JobsTable, type JobsFilter } from '../views/jobs'
import { JobPage, LOG_DOM_LINES } from '../views/job'
import { ReposPage } from '../views/repos'
import { RunnerTypesPage, SlotsMatrix } from '../views/runner-types'
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
      const since = query.since && !Number.isNaN(Date.parse(query.since)) ? new Date(Date.parse(query.since)).toISOString() : undefined
      const filter: JobsFilter = {
        repo: query.repo || undefined,
        status,
        q: query.q?.trim() || undefined,
        since,
        running: query.running === '1' || undefined,
        failed: query.failed === '1' || undefined,
      }
      const [jobs, runners, repos] = await Promise.all([
        service.listJobs({ ...filter, limit: 200 }),
        service.listRunners({ limit: 1000 }),
        query.partial ? Promise.resolve([]) : service.listRepos(),
      ])
      const runnerNames = Object.fromEntries(runners.map((r) => [r.id, r.name]))
      if (query.partial) return <JobsTable jobs={jobs} filter={filter} runnerNames={runnerNames} />
      return page('jobs', 'Jobs', <JobsPage jobs={jobs} repos={repos} filter={filter} runnerNames={runnerNames} />)
    },
    {
      query: t.Object({
        partial: t.Optional(t.String()),
        repo: t.Optional(t.String({ maxLength: 200 })),
        status: t.Optional(t.String({ maxLength: 20 })),
        q: t.Optional(t.String({ maxLength: 200 })),
        since: t.Optional(t.String({ maxLength: 40 })),
        running: t.Optional(t.String({ maxLength: 1 })),
        failed: t.Optional(t.String({ maxLength: 1 })),
        job: t.Optional(t.String()),
      }),
    },
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
    return page('repos', 'Repos', <ReposPage repos={repos} types={types} githubAuth={service.githubAuthKind()} />)
  })

  .get(
    '/templates',
    async ({ query }) => {
      const [types, hosts, slots] = await Promise.all([service.listRunnerTypes(), service.listHosts(), service.listSlots()])
      if (query.partial) return <SlotsMatrix types={types} hosts={hosts} slots={slots} />
      const settings = await service.getSettings().catch(() => ({}) as Record<string, string>)
      const imageDefault = settings['runner_image_default'] || SETTING_DEFAULTS['runner_image_default']!
      return page('templates', 'Templates', <RunnerTypesPage types={types} hosts={hosts} slots={slots} imageDefault={imageDefault} />)
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

import type { Host, Repo, Runner, Slot } from '../lib/types'
import { JobsPager, JobsTable, JobsToolbar, RECENT_SCOPE, jobsQuery, JOBS_SCOPE, type JobsView } from './jobs-table'
import { Empty, Icon, RelTime, RunnerBadge, gb } from './parts'

export type OverviewData = { hosts: Host[]; slots: Slot[]; runners: Runner[] }
export type RecentJobsData = JobsView & { repos: Repo[] }

const LIVE_STATES = new Set(['spawning', 'idle', 'busy'])

/** Pills read well up to this many slots; beyond it the row falls back to the bar and count. */
const PILL_MAX = 12

const LeaderBadge = () => (
  <span
    class="t-badge host-leader"
    data-tone="accent"
    data-size="xs"
    data-tip="Leader: the one node that runs the cluster-wide chores (GitHub polling, stale-runner cleanup, retention purge, migrations). Elected with a database lock; another node takes over when it goes away. Every node schedules its own runners."
  >
    <Icon id="bi-star-fill" size="xs" /> leader
  </span>
)

/** `8 CPU · 32 GB · Docker 26.1.4 · seen just now`; parts the node has not reported are left out. */
const HostSpecs = ({ host }: { host: Host }) => {
  const parts: JSX.Element[] = []
  if (host.cpus !== null) parts.push(<>{`${host.cpus} CPU`}</>)
  if (host.memoryMb !== null) parts.push(<>{`${gb(host.memoryMb)} GB`}</>)
  if (host.dockerVersion !== null) parts.push(<span safe>{`Docker ${host.dockerVersion}`}</span>)
  parts.push(
    <>
      seen <RelTime at={host.lastSeenAt} />
    </>,
  )
  return (
    <span class="t-muted t-small host-specs">
      {parts.map((part, i) => (
        <>
          {i > 0 ? ' · ' : ''}
          {part}
        </>
      ))}
    </span>
  )
}

/** One row per template with slots on this host: the name, then one pill per slot (filled = busy). */
const SlotRow = ({ slot }: { slot: Slot }) => (
  <div class="slot-row" data-type={slot.type} data-tip={`${slot.type} on ${slot.host}: ${slot.used}/${slot.count}`}>
    <a href={`/templates#${encodeURIComponent(slot.type)}`} class="t-mono t-small slot-type" safe>
      {slot.type}
    </a>
    {slot.count > PILL_MAX ? (
      <SlotBar slot={slot} />
    ) : (
      <span class="slot-pills" role="img" aria-label={`${slot.type} on ${slot.host}: ${slot.used} of ${slot.count} slots used`}>
        {Array.from({ length: slot.count }, (_, i) => (
          <span class="slot-pill" data-busy={i < slot.used ? 'true' : undefined}></span>
        ))}
      </span>
    )}
  </div>
)

/** One host column: a one-line header, the slot summary, then one row per template with slots here. */
const HostSection = ({ host, slots }: { host: Host; slots: Slot[] }) => {
  const mine = slots.filter((s) => s.host === host.name && s.count > 0).sort((a, b) => a.type.localeCompare(b.type))
  const used = mine.reduce((n, s) => n + s.used, 0)
  const total = mine.reduce((n, s) => n + s.count, 0)
  const offline = host.status === 'offline'
  return (
    <section class="host-section" data-name={host.name} data-tone={offline ? 'danger' : undefined} aria-label={`Host ${host.name}`}>
      <header class="host-head t-cluster" data-gap="2" data-align="center">
        <span class="t-dot" data-status={host.status === 'online' ? (host.dockerOk ? 'running' : 'degraded') : 'stopped'} data-tip={host.status}></span>
        <a class="t-mono host-name" href={`/hosts#${encodeURIComponent(host.name)}`} data-tip="Host details" safe>
          {host.name}
        </a>
        {host.isLeader ? <LeaderBadge /> : null}
        {offline ? (
          <span class="t-badge" data-tone="danger" data-size="xs">
            offline
          </span>
        ) : null}
        {host.dockerOk ? null : (
          <span class="t-badge" data-tone="danger" data-size="xs" data-tip="This node cannot reach its container engine">
            Docker unreachable
          </span>
        )}
        <span class="t-toolbar-spacer"></span>
        <HostSpecs host={host} />
      </header>
      <p class="t-small host-summary" data-tone={total > 0 && used === total ? 'warning' : undefined}>
        {total === 0 ? (
          <>
            No slots on this host. <a href="/templates">Set some under Templates</a>
          </>
        ) : (
          `${used} of ${total} slots busy`
        )}
      </p>
      {mine.length > 0 ? (
        <div class="host-slots t-stack" data-gap="1" aria-label={`Slots on ${host.name}`}>
          {mine.map((s) => (
            <SlotRow slot={s} />
          ))}
        </div>
      ) : null}
    </section>
  )
}

const SlotBar = ({ slot }: { slot: Slot }) => {
  const pct = slot.count > 0 ? Math.round((slot.used / slot.count) * 100) : 0
  const tone = slot.count === 0 ? 'neutral' : slot.free === 0 ? 'warning' : 'success'
  return (
    <div class="slot-bar">
      <span class="t-small t-mono" data-tip={`${slot.free} free`}>{`${slot.used}/${slot.count}`}</span>
      <div
        class="t-progress"
        data-size="sm"
        role="progressbar"
        aria-valuenow={String(slot.used)}
        aria-valuemin="0"
        aria-valuemax={String(slot.count)}
        aria-label={`${slot.type} on ${slot.host}: ${slot.used} of ${slot.count} slots used`}
      >
        <div class="t-progress-bar" data-tone={tone} style={`--t-value: ${pct}%`}></div>
      </div>
    </div>
  )
}

export const RunnersTable = ({ runners }: { runners: Runner[] }) => {
  const live = runners.filter((r) => LIVE_STATES.has(r.state))
  if (live.length === 0) {
    return (
      <Empty icon="bi-inbox" title="No runners right now" text="A runner starts when a queued job matches a template with a free slot." size="sm">
        <a class="t-btn" data-size="sm" data-variant="ghost" href="/templates">
          Spawn one from Templates
        </a>
      </Empty>
    )
  }
  return (
    <div class="t-table-wrap">
      <table class="t-table" data-variant="data" data-density="compact" id="runners-table">
        <thead>
          <tr>
            <th data-sort="name">
              <button>
                Runner <span class="t-sort-icon"></span>
              </button>
            </th>
            <th data-sort="host">
              <button>
                Host <span class="t-sort-icon"></span>
              </button>
            </th>
            <th data-sort="type">
              <button>
                Template <span class="t-sort-icon"></span>
              </button>
            </th>
            <th data-sort="state">
              <button>
                State <span class="t-sort-icon"></span>
              </button>
            </th>
            <th>Repo</th>
            <th>Job</th>
            <th data-sort="since">
              <button>
                Since <span class="t-sort-icon"></span>
              </button>
            </th>
            <th class="t-col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {live.map((r) => (
            <tr data-runner-id={String(r.id)} data-name={r.name} data-host={r.host} data-type={r.type} data-state={r.state} data-since={r.createdAt}>
              <td>
                <a class="t-mono" href={`/jobs?runner=${encodeURIComponent(r.name)}`} data-tip="Jobs this runner handled" safe>
                  {r.name}
                </a>
              </td>
              <td>
                <a href={`/hosts#${encodeURIComponent(r.host)}`} data-tip="Host details" safe>
                  {r.host}
                </a>
              </td>
              <td>
                <a href={`/templates#${encodeURIComponent(r.type)}`} data-tip="Template" safe>
                  {r.type}
                </a>
              </td>
              <td>
                <RunnerBadge state={r.state} />
              </td>
              <td>
                {r.repo ? (
                  <a href={`/jobs?repo=${encodeURIComponent(r.repo)}`} safe>
                    {r.repo}
                  </a>
                ) : (
                  <span class="t-muted">–</span>
                )}
              </td>
              <td>
                {r.jobId ? (
                  <a href={`/jobs/${r.jobId}`} data-tip="Open the job and its log" safe>
                    {r.jobName ?? `job #${r.jobId}`}
                  </a>
                ) : (
                  <span class="t-muted">waiting</span>
                )}
              </td>
              <td>
                <RelTime at={r.createdAt} />
              </td>
              <td class="t-col-actions">
                <button
                  class="t-btn"
                  data-size="sm"
                  data-variant="ghost"
                  data-tone="danger"
                  data-icon="only"
                  data-tip="Kill runner"
                  data-action="kill"
                  data-id={String(r.id)}
                  data-name={r.name}
                  data-job={r.jobName ?? ''}
                >
                  <Icon id="bi-x-octagon" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The live block: re-fetched whole by `app.js` on `runner` / `slot` events (`GET /?partial=1`). */
export const OverviewLive = ({ hosts, slots, runners }: OverviewData) => {
  if (hosts.length === 0) {
    return (
      <div id="overview-live" data-live="runner slot">
        <Empty icon="bi-hdd-rack" title="No hosts yet" text="A node registers itself on boot. Start one OctoHatchery instance with access to a Docker socket and it appears here with its slots." />
      </div>
    )
  }
  return (
    <div id="overview-live" data-live="runner slot" class="t-stack" data-gap="4">
      <section class="t-card" aria-labelledby="overview-hosts-title">
        <div class="t-card-header">
          <h2 class="t-card-title" id="overview-hosts-title">
            <Icon id="bi-hdd-rack" /> Hosts <span class="t-counter">{String(hosts.length)}</span>{' '}
            <span class="t-help" data-tone="info">
              <button class="t-help-btn" type="button" aria-expanded="false" aria-label="About slots">
                i
              </button>
              <div class="t-help-box" hidden>
                <p>A slot is one runner of a template allowed on a host at a time. Each pill is one slot; a filled pill is busy. Set slots under Templates.</p>
              </div>
            </span>
          </h2>
          <div class="t-card-tools">
            <a class="t-btn" data-size="xs" data-variant="ghost" href="/hosts">
              All hosts <Icon id="bi-arrow-right" size="xs" />
            </a>
          </div>
        </div>
        <div class="t-card-body host-list t-grid" data-min="md">
          {hosts.map((h) => (
            <HostSection host={h} slots={slots} />
          ))}
        </div>
      </section>
      <section class="t-section">
        <h2 class="t-section-title">
          Runners <span class="t-counter">{String(runners.filter((r) => LIVE_STATES.has(r.state)).length)}</span>
        </h2>
        <div class="t-section-body">
          <RunnersTable runners={runners} />
        </div>
      </section>
    </div>
  )
}

/**
 * The "Recent jobs" card: the Jobs toolbar and table under the `j_` param prefix so its filters and paging never
 * collide with the rest of the page. Its own live block (`job` / `runner` events, `GET /?…&partial=jobs`).
 */
export const RecentJobs = ({ repos, ...view }: RecentJobsData) => (
  <section class="t-card" id="recent-jobs" data-live="job runner" data-partial="jobs" aria-labelledby="recent-jobs-title">
    <div class="t-card-header">
      <h2 class="t-card-title" id="recent-jobs-title">
        <Icon id="bi-briefcase" /> Recent jobs <span class="t-counter" data-tip="Jobs matching the filter">{String(view.total)}</span>
      </h2>
      <div class="t-card-tools">
        <a class="t-btn" data-size="xs" data-variant="ghost" href={`/jobs${jobsQuery(JOBS_SCOPE, view.filter)}`} data-tip="The Jobs page with the same filters">
          All jobs <Icon id="bi-arrow-right" size="xs" />
        </a>
      </div>
    </div>
    <div class="t-card-body t-stack" data-gap="3">
      <JobsToolbar scope={RECENT_SCOPE} filter={view.filter} repos={repos} per={view.per} />
      <JobsTable scope={RECENT_SCOPE} jobs={view.jobs} filter={view.filter} runnerNames={view.runnerNames} />
      <JobsPager scope={RECENT_SCOPE} view={view} showAll />
    </div>
  </section>
)

export const OverviewPage = ({ recent, ...data }: OverviewData & { recent: RecentJobsData }) => (
  <>
    <header class="t-page-header">
      <h1 class="t-page-title">Overview</h1>
      <span class="t-page-lead">Hosts, slots, the runners working right now and the latest jobs.</span>
    </header>
    <div class="t-stack" data-gap="4">
      <OverviewLive {...data} />
      <RecentJobs {...recent} />
    </div>
  </>
)


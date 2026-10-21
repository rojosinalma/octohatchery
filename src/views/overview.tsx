import type { Host, Repo, Runner, Slot } from '../lib/types'
import { JobsPager, JobsTable, JobsToolbar, RECENT_SCOPE, jobsQuery, JOBS_SCOPE, type JobsView } from './jobs-table'
import { Empty, Icon, RelTime, gb } from './parts'

export type OverviewData = { hosts: Host[]; slots: Slot[]; runners: Runner[] }
export type RecentJobsData = JobsView & { repos: Repo[] }

const LIVE_STATES = new Set(['spawning', 'idle', 'busy'])

/** Pills read well up to this many slots; beyond it the row falls back to the bar and count. */
const PILL_MAX = 12

/** At most this many host columns per row: a column stays wide enough for full template names and a runner capsule. */
const HOST_COLS_MAX = 3
/** The host grid has this many tracks; a host spans `HOST_TRACKS / hosts in its row`, so every row splits equally. */
const HOST_TRACKS = 6

/**
 * Hosts per row: as few rows as the column cap allows, filled as evenly as possible (4 → 2+2, 5 → 3+2, 7 → 3+2+2),
 * so a host never sits alone in a short last row while a longer row exists above it.
 */
export function hostRows(count: number): number[] {
  if (count <= 0) return []
  const rows = Math.ceil(count / HOST_COLS_MAX)
  const base = Math.floor(count / rows)
  const extra = count % rows
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0))
}

/** The track span of each host in order, for `data-span` on its column. */
export function hostSpans(count: number): number[] {
  return hostRows(count).flatMap((n) => Array.from({ length: n }, () => HOST_TRACKS / n))
}

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

/** Short label for what a runner in a slot is doing: the job (and repo) when busy, else its state. */
const seatLabel = (r: Runner) => (r.state === 'spawning' ? 'starting' : r.state === 'idle' ? 'waiting for a job' : (r.jobName ?? (r.jobId ? `job #${r.jobId}` : 'busy')))

/**
 * A slot held by a runner: the circle stays the slot (filled, tone by state) and the capsule around it grows to the
 * left with the job it runs and a kill button, so each runner sits visibly in its own slot.
 */
const SeatRunner = ({ runner }: { runner: Runner }) => {
  const repo = runner.repo ? runner.repo.slice(runner.repo.indexOf('/') + 1) : null
  const tip = [runner.name, runner.jobName, runner.repo].filter(Boolean).join(' · ')
  return (
    <span class="slot-seat" data-state={runner.state} data-runner-id={String(runner.id)}>
      <button
        class="t-btn slot-seat-kill"
        data-size="xs"
        data-variant="ghost"
        data-tone="danger"
        data-icon="only"
        data-tip="Kill runner"
        aria-label={`Kill runner ${runner.name}`}
        data-action="kill"
        data-id={String(runner.id)}
        data-name={runner.name}
        data-job={runner.jobName ?? ''}
      >
        <Icon id="bi-x-lg" size="xs" />
      </button>
      <a class="slot-seat-label" href={runner.jobId ? `/jobs/${runner.jobId}` : `/jobs?runner=${encodeURIComponent(runner.name)}`} data-tip={tip}>
        <span class="slot-seat-job" safe>
          {seatLabel(runner)}
        </span>
        {runner.state === 'busy' && repo ? (
          <span class="slot-seat-repo t-muted" safe>
            {repo}
          </span>
        ) : null}
      </a>
      <span class="slot-pill" data-busy="true" data-state={runner.state}></span>
    </span>
  )
}

/**
 * One row per template with slots on this host: the name on the left, the slots as circles on the right edge.
 * Runners come first so the row grows to the left; free circles stay at the right end.
 */
const SlotRow = ({ slot, runners }: { slot: Slot; runners: Runner[] }) => {
  const seated = runners.filter((r) => r.host === slot.host && r.type === slot.type && LIVE_STATES.has(r.state)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  // A claimed slot whose runner is not listed yet still reads as busy.
  const claimed = Math.max(0, slot.used - seated.length)
  const free = Math.max(0, slot.count - seated.length - claimed)
  return (
    <div class="slot-row" data-type={slot.type}>
      <a href={`/templates#${encodeURIComponent(slot.type)}`} class="t-mono t-small slot-type" data-tip="Template" safe>
        {slot.type}
      </a>
      <span class="slot-pills" role="group" aria-label={`${slot.type} on ${slot.host}: ${slot.used} of ${slot.count} slots used`}>
        {seated.map((r) => (
          <SeatRunner runner={r} />
        ))}
        {slot.count > PILL_MAX ? (
          <SlotBar slot={slot} />
        ) : (
          <>
            {Array.from({ length: claimed }, () => (
              <span class="slot-pill" data-busy="true" data-tip="Claimed, runner starting"></span>
            ))}
            {Array.from({ length: free }, () => (
              <span class="slot-pill" data-tip="Free slot"></span>
            ))}
          </>
        )}
      </span>
    </div>
  )
}

/** One host column: a one-line header, the slot summary, then one row per template with slots here. */
const HostSection = ({ host, slots, runners, span }: { host: Host; slots: Slot[]; runners: Runner[]; span: number }) => {
  const mine = slots.filter((s) => s.host === host.name && s.count > 0).sort((a, b) => a.type.localeCompare(b.type))
  const used = mine.reduce((n, s) => n + s.used, 0)
  const total = mine.reduce((n, s) => n + s.count, 0)
  const offline = host.status === 'offline'
  return (
    <section class="host-section" data-name={host.name} data-span={String(span)} data-tone={offline ? 'danger' : undefined} aria-label={`Host ${host.name}`}>
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
        <div class="host-slots" aria-label={`Slots on ${host.name}`}>
          {mine.map((s) => (
            <SlotRow slot={s} runners={runners} />
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

/** The live block: re-fetched whole by `app.js` on `runner` / `slot` events (`GET /?partial=1`). */
export const OverviewLive = ({ hosts, slots, runners }: OverviewData) => {
  const spans = hostSpans(hosts.length)
  if (hosts.length === 0) {
    return (
      <div id="overview-live" data-live="runner slot">
        <Empty icon="bi-hdd-rack" title="No hosts yet" text="A node registers itself on boot. Start one OctoHatchery instance with access to a Docker socket and it appears here with its slots." />
      </div>
    )
  }
  return (
    <div id="overview-live" data-live="runner slot">
      <section class="t-card" aria-labelledby="overview-hosts-title">
        <div class="t-card-header">
          <h2 class="t-card-title" id="overview-hosts-title">
            <Icon id="bi-hdd-rack" /> Hosts <span class="t-counter">{String(hosts.length)}</span>{' '}
            <span class="t-help" data-tone="info">
              <button class="t-help-btn" type="button" aria-expanded="false" aria-label="About slots">
                i
              </button>
              <div class="t-help-box" hidden>
                <p>A slot is one runner of a template allowed on a host at a time. Each circle is one slot. A runner in a slot shows the job it works on; the × kills it. Set slots under Templates.</p>
              </div>
            </span>
          </h2>
          <div class="t-card-tools">
            <a class="t-btn" data-size="xs" data-variant="ghost" href="/hosts">
              All hosts <Icon id="bi-arrow-right" size="xs" />
            </a>
          </div>
        </div>
        <div class="t-card-body host-list" data-hosts={String(hosts.length)}>
          {hosts.map((h, i) => (
            <HostSection host={h} slots={slots} runners={runners} span={spans[i] ?? HOST_TRACKS} />
          ))}
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
    <div class="t-stack overview-stack" data-gap="5">
      <OverviewLive {...data} />
      <RecentJobs {...recent} />
    </div>
  </>
)


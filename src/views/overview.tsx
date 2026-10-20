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

/** One runner in a slot seat: busy tile, spawning, idle, or free. */
const RunnerSeat = ({ runner }: { runner?: Runner }) => {
  if (!runner) {
    return (
      <div class="runner-seat runner-seat-free" data-tip="Free slot">
        <span class="t-muted t-small">free</span>
      </div>
    )
  }

  const isBusy = runner.state === 'busy'
  const isSpawning = runner.state === 'spawning'
  const jobDisplay = runner.repo ? runner.repo.split('/')[1] : runner.jobId ? String(runner.jobId).slice(0, 6) : '—'

  return (
    <a
      href={`/jobs?runner=${encodeURIComponent(runner.name)}`}
      class="runner-seat"
      data-state={runner.state}
      data-tip={`${runner.name} · ${runner.state}${isBusy && runner.jobName ? ` · ${runner.jobName}` : ''}`}
    >
      <span class="runner-seat-state">
        {isBusy && <Icon id="bi-play-circle-fill" size="xs" />}
        {runner.state === 'idle' && <Icon id="bi-circle-fill" size="xs" />}
        {isSpawning && <span class="t-spinner" style="--t-spinner-size: 0.7rem"></span>}
      </span>
      <span class="runner-seat-info">
        {isBusy ? (
          <span class="runner-seat-job">{jobDisplay}</span>
        ) : (
          <span class="runner-seat-state-text">{runner.state}</span>
        )}
      </span>
    </a>
  )
}

/** One row per template with its slots shown as seats (busy runners, free, etc). */
const SlotRow = ({ slot, runners }: { slot: Slot; runners: Runner[] }) => {
  const runnersBySlot = new Map<number, Runner>()
  // Runners are listed in creation order; assume they fill slots 0..used-1
  runners.slice(0, slot.used).forEach((r, i) => {
    runnersBySlot.set(i, r)
  })

  return (
    <div class="slot-row" data-type={slot.type}>
      <a href={`/templates#${encodeURIComponent(slot.type)}`} class="slot-type" safe>
        {slot.type}
      </a>
      <div class="slot-seats">
        {slot.count > PILL_MAX ? (
          <>
            <SlotBar slot={slot} />
            {Array.from({ length: slot.used }, (_, i) => (
              <RunnerSeat runner={runnersBySlot.get(i)} />
            ))}
            {slot.free > 0 && <span class="slot-free-count t-muted t-small">+{slot.free} free</span>}
          </>
        ) : (
          <>
            {Array.from({ length: slot.count }, (_, i) => (
              runnersBySlot.get(i) ? (
                <RunnerSeat runner={runnersBySlot.get(i)} />
              ) : (
                <span class="slot-pill" data-tip="Free slot"></span>
              )
            ))}
          </>
        )}
      </div>
    </div>
  )
}

/** Progress bar for 12+ slots. */
const SlotBar = ({ slot }: { slot: Slot }) => (
  <div class="t-progress" role="progressbar" aria-valuenow={slot.used} aria-valuemin={0} aria-valuemax={slot.count} style={`--t-value: ${Math.round((slot.used * 100) / slot.count)}%`} data-tip={`${slot.used}/${slot.count} slots busy`}>
    <div class="t-progress-bar"></div>
  </div>
)

/** One host column: a one-line header, the slot summary, then one row per template with slots here. */
const HostSection = ({ host, slots, runners }: { host: Host; slots: Slot[]; runners: Runner[] }) => {
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
        {host.dockerOk === false ? (
          <span class="t-badge" data-tone="danger" data-size="xs">
            Docker unreachable
          </span>
        ) : null}
        <HostSpecs host={host} />
      </header>
      {mine.length > 0 ? (
        <div class="host-templates">
          {mine.map((slot) => (
            <SlotRow slot={slot} runners={runners.filter((r) => r.host === host.name && r.type === slot.type)} />
          ))}
        </div>
      ) : (
        <p class="t-small t-muted">
          No slots on this host. <a href="/templates">Set some under Templates</a>
        </p>
      )}
    </section>
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
                <p>Each column is a host and its templates. Runners appear as tiles in their slots. Set slots under Templates.</p>
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
            <HostSection host={h} slots={slots} runners={runners} />
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
    <div class="t-stack" data-gap="5">
      <OverviewLive {...data} />
      <RecentJobs {...recent} />
    </div>
  </>
)

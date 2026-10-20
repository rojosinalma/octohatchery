import type { Host, Runner, Slot } from '../lib/types'
import { Empty, Icon, RelTime, RunnerBadge } from './parts'

export type OverviewData = { hosts: Host[]; slots: Slot[]; runners: Runner[] }

const LIVE_STATES = new Set(['spawning', 'idle', 'busy'])

const HostsTable = ({ hosts }: { hosts: Host[] }) => (
  <div class="t-table-wrap">
    <table class="t-table" data-variant="data" data-density="compact" id="hosts-table">
      <thead>
        <tr>
          <th class="t-col-icon"></th>
          <th>Host</th>
          <th>Status</th>
          <th>Docker</th>
          <th>Last seen</th>
        </tr>
      </thead>
      <tbody>
        {hosts.map((h) => (
          <tr data-name={h.name} data-tone={h.status === 'offline' ? 'danger' : undefined}>
            <td class="t-col-icon">
              <span class="t-dot" data-status={h.status === 'online' ? (h.dockerOk ? 'running' : 'degraded') : 'stopped'} data-tip={h.status}></span>
            </td>
            <td>
              <span class="t-mono" safe>
                {h.name}
              </span>{' '}
              {h.isLeader ? (
                <span class="t-badge" data-tone="accent" data-tip="Leader: the one node that runs the cluster-wide chores (GitHub polling, stale-runner cleanup, retention purge, migrations). Elected with a database lock; another node takes over when it goes away. Every node schedules its own runners.">
                  <Icon id="bi-star-fill" size="xs" /> leader
                </span>
              ) : null}
            </td>
            <td>
              <span class="t-badge" data-tone={h.status === 'online' ? 'success' : 'danger'} safe>
                {h.status}
              </span>
            </td>
            <td>
              <span class="t-badge" data-tone={h.dockerOk ? 'success' : 'danger'}>
                {h.dockerOk ? 'ok' : 'unreachable'}
              </span>
            </td>
            <td>
              <RelTime at={h.lastSeenAt} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

const SlotsTable = ({ slots }: { slots: Slot[] }) => {
  const types = [...new Set(slots.map((s) => s.type))].sort()
  const hosts = [...new Set(slots.map((s) => s.host))].sort()
  const cell = (type: string, host: string) => slots.find((s) => s.type === type && s.host === host)
  return (
    <div class="t-table-wrap">
      <table class="t-table" data-variant="data" data-density="compact" id="slots-table">
        <thead>
          <tr>
            <th>Type</th>
            {hosts.map((h) => (
              <th safe>{h}</th>
            ))}
            <th class="t-col-num">Total</th>
          </tr>
        </thead>
        <tbody>
          {types.map((t) => {
            const row = slots.filter((s) => s.type === t)
            const used = row.reduce((n, s) => n + s.used, 0)
            const count = row.reduce((n, s) => n + s.count, 0)
            return (
              <tr data-type={t}>
                <td>
                  <a href="/runner-types" class="t-mono" safe>
                    {t}
                  </a>
                </td>
                {hosts.map((h) => {
                  const s = cell(t, h)
                  return <td>{s ? <SlotBar slot={s} /> : <span class="t-muted">–</span>}</td>
                })}
                <td class="t-col-num">
                  <span class="t-mono">{`${used}/${count}`}</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
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
      <Empty icon="bi-inbox" title="No runners right now" text="A runner starts when a queued job matches a runner type with a free slot. Spawn one by hand from Runner types." >
        <a class="t-btn" data-variant="primary" href="/runner-types">
          Runner types
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
                Type <span class="t-sort-icon"></span>
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
              <td class="t-mono" safe>
                {r.name}
              </td>
              <td safe>{r.host}</td>
              <td safe>{r.type}</td>
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
      <section class="t-section">
        <h2 class="t-section-title">
          Hosts <span class="t-counter">{String(hosts.length)}</span>
        </h2>
        <div class="t-section-body">
          <HostsTable hosts={hosts} />
        </div>
      </section>
      <section class="t-section">
        <h2 class="t-section-title">Slots (used / total)</h2>
        <div class="t-section-body">
          {slots.length === 0 ? (
            <Empty icon="bi-cpu" title="No slots set" text="Give a runner type a slot count per host under Runner types. A slot is one runner that may run at a time.">
              <a class="t-btn" data-variant="primary" href="/runner-types">
                Runner types
              </a>
            </Empty>
          ) : (
            <SlotsTable slots={slots} />
          )}
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

export const OverviewPage = (data: OverviewData) => (
  <>
    <header class="t-page-header">
      <h1 class="t-page-title">Overview</h1>
      <span class="t-page-lead">Hosts, slots and the runners working right now.</span>
    </header>
    <OverviewLive {...data} />
  </>
)


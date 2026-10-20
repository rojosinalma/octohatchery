import type { Job, JobStatus, Repo } from '../lib/types'
import { Empty, Icon, JobBadge, RelTime } from './parts'

export type JobsFilter = { repo?: string; status?: JobStatus; q?: string; since?: string; running?: boolean; failed?: boolean }
/** Runner id → runner name, for the Runner column (jobs store the id only). */
export type RunnerNames = Record<number, string>
export type JobsData = { jobs: Job[]; repos: Repo[]; filter: JobsFilter; runnerNames: RunnerNames }

export const JOB_STATUSES: JobStatus[] = ['queued', 'claimed', 'in_progress', 'completed', 'ignored']

const STATUS_LABEL: Record<JobStatus, string> = { queued: 'Queued', claimed: 'Claimed', in_progress: 'In progress', completed: 'Completed', ignored: 'Ignored' }

const HOUR_MS = 3_600_000
/** Quick time filters: label, span, and how far a stored `since` may drift from "now minus span" and still count as pressed. */
const SINCE_PRESETS: { key: string; label: string; ms: number }[] = [
  { key: '24h', label: 'Last 24 h', ms: 24 * HOUR_MS },
  { key: '7d', label: 'This week', ms: 7 * 24 * HOUR_MS },
]
const PRESET_TOLERANCE_MS = 10 * 60_000

const query = (f: JobsFilter) => {
  const q = new URLSearchParams()
  if (f.repo) q.set('repo', f.repo)
  if (f.status) q.set('status', f.status)
  if (f.q) q.set('q', f.q)
  if (f.since) q.set('since', f.since)
  if (f.running) q.set('running', '1')
  if (f.failed) q.set('failed', '1')
  const s = q.toString()
  return s ? `?${s}` : ''
}

const isFiltered = (f: JobsFilter) => Boolean(f.repo || f.status || f.q || f.since || f.running || f.failed)

const duration = (job: Job) => {
  if (!job.startedAt) return null
  const end = job.completedAt ? new Date(job.completedAt).getTime() : Date.now()
  const s = Math.max(0, Math.round((end - new Date(job.startedAt).getTime()) / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}

/** The table block: re-fetched by `app.js` on `job` events (`GET /jobs?…&partial=1`). */
export const JobsTable = ({ jobs, filter, runnerNames }: Pick<JobsData, 'jobs' | 'filter' | 'runnerNames'>) => {
  if (jobs.length === 0) {
    const filtered = isFiltered(filter)
    return (
      <div id="jobs-live" data-live="job">
        <Empty
          icon="bi-briefcase"
          title={filtered ? 'No jobs match this filter' : 'No jobs yet'}
          text={filtered ? 'Clear the filters to see every job in the retention window.' : 'Jobs arrive through the GitHub webhook as soon as an adopted repo queues a workflow job.'}
        >
          {filtered ? (
            <a class="t-btn" href="/jobs">
              Clear filters
            </a>
          ) : (
            <a class="t-btn" data-variant="primary" href="/repos">
              Adopt a repo
            </a>
          )}
        </Empty>
      </div>
    )
  }
  return (
    <div id="jobs-live" data-live="job" class="t-table-wrap">
      <table class="t-table" data-variant="data" data-density="compact" id="jobs-table">
        <thead>
          <tr>
            <th data-sort="runner">
              <button>
                Runner <span class="t-sort-icon"></span>
              </button>
            </th>
            <th data-sort="status">
              <button>
                Status <span class="t-sort-icon"></span>
              </button>
            </th>
            <th data-sort="job">
              <button>
                Job <span class="t-sort-icon"></span>
              </button>
            </th>
            <th data-sort="repo">
              <button>
                Repo <span class="t-sort-icon"></span>
              </button>
            </th>
            <th data-sort="queued">
              <button>
                Queued <span class="t-sort-icon"></span>
              </button>
            </th>
            <th class="t-col-num">Duration</th>
            <th class="t-col-actions">Run</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => {
            const runner = j.runnerId === null ? undefined : runnerNames[j.runnerId]
            return (
              <tr
                data-job-id={String(j.id)}
                data-runner={runner ?? ''}
                data-status={j.status}
                data-job={j.name}
                data-repo={j.repo}
                data-queued={j.queuedAt}
                data-tone={j.status === 'completed' && j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'cancelled' && j.conclusion !== 'skipped' ? 'danger' : undefined}
              >
                <td>
                  {j.runnerId === null ? (
                    <span class="t-muted">–</span>
                  ) : (
                    <a class="t-mono" href={`/jobs/${j.id}`} data-tip="Open the job and its log" safe>
                      {runner ?? `#${j.runnerId}`}
                    </a>
                  )}
                </td>
                <td>
                  <JobBadge status={j.status} conclusion={j.conclusion} />
                </td>
                <td>
                  <a href={`/jobs/${j.id}`} data-tip="Open the job and its log" safe>
                    {j.name}
                  </a>
                </td>
                <td>
                  <a href={`/jobs?repo=${encodeURIComponent(j.repo)}`} safe>
                    {j.repo}
                  </a>
                </td>
                <td>
                  <RelTime at={j.queuedAt} />
                </td>
                <td class="t-col-num">{duration(j) ?? <span class="t-muted">–</span>}</td>
                <td class="t-col-actions">
                  <a class="t-btn" data-size="sm" data-variant="ghost" data-icon="only" href={j.htmlUrl} target="_blank" rel="noopener" data-tip="Open run on GitHub" aria-label="Open run on GitHub">
                    <Icon id="bi-github" />
                  </a>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export const JobsPage = ({ jobs, repos, filter, runnerNames }: JobsData) => {
  const now = Date.now()
  const sinceMs = filter.since ? Date.parse(filter.since) : NaN
  const pressed = (ms: number) => !Number.isNaN(sinceMs) && Math.abs(now - ms - sinceMs) <= PRESET_TOLERANCE_MS
  const toggle = (patch: Partial<JobsFilter>, on: boolean) => `/jobs${query({ ...filter, ...(on ? Object.fromEntries(Object.keys(patch).map((k) => [k, undefined])) : patch) })}`
  return (
    <>
      <header class="t-page-header">
        <h1 class="t-page-title">Jobs</h1>
        <span class="t-page-lead">Queue and history. Filter by status, repo or text; the quick filters narrow it further.</span>
      </header>
      <div class="t-toolbar page-toolbar jobs-toolbar" role="toolbar" aria-label="Job filters">
        <select class="t-select" data-size="sm" data-width="auto" aria-label="Status" data-nav="status" id="jobs-status">
          <option value="" selected={!filter.status}>
            All statuses
          </option>
          {JOB_STATUSES.map((s) => (
            <option value={s} selected={filter.status === s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select class="t-select" data-size="sm" data-width="auto" aria-label="Repo" data-nav="repo" id="jobs-repo">
          <option value="" selected={!filter.repo}>
            All repos
          </option>
          {[...new Set([...repos.map((r) => r.fullName), ...(filter.repo ? [filter.repo] : [])])].sort().map((name) => (
            <option value={name} selected={filter.repo === name} safe>
              {name}
            </option>
          ))}
        </select>
        <input class="t-input" data-size="sm" data-width="auto" type="search" id="jobs-search" name="q" data-nav="q" data-nav-on="enter" placeholder="Search jobs…" aria-label="Search jobs" value={filter.q ?? ''} autocomplete="off" />
        <span class="t-toolbar-spacer"></span>
        <div class="t-btn-group" role="group" data-role="filter" aria-label="Quick filters">
          <a class="t-btn" data-size="sm" href={toggle({ running: true }, Boolean(filter.running))} aria-pressed={filter.running ? 'true' : 'false'}>
            Running now
          </a>
          <a class="t-btn" data-size="sm" href={toggle({ failed: true }, Boolean(filter.failed))} aria-pressed={filter.failed ? 'true' : 'false'}>
            Failed
          </a>
          {SINCE_PRESETS.map((p) => (
            <a class="t-btn" data-size="sm" href={toggle({ since: new Date(now - p.ms).toISOString() }, pressed(p.ms))} aria-pressed={pressed(p.ms) ? 'true' : 'false'} data-preset={p.key}>
              {p.label}
            </a>
          ))}
        </div>
      </div>
      <JobsTable jobs={jobs} filter={filter} runnerNames={runnerNames} />
    </>
  )
}

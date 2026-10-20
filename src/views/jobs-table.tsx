import { JOBS_PER_MAX, JOBS_PER_PAGE, type Job, type JobStatus, type Repo } from '../lib/types'
import type { JobsFilter } from '../lib/service'
import { Empty, Icon, JobBadge, RelTime } from './parts'

export type { JobsFilter }
/** Runner id → runner name, for the Runner column (jobs store the id only). */
export type RunnerNames = Record<number, string>

/**
 * Where a jobs list lives: `base` is the page path its links point at, `prefix` goes in front of every
 * query param (`''` on `/jobs`, `j_` on the Overview so the two lists never share a param), `id` prefixes
 * element ids, `per` is the page size when the URL names none.
 */
export type JobsScope = { base: string; prefix: string; id: string; per: number }
export const JOBS_SCOPE: JobsScope = { base: '/jobs', prefix: '', id: 'jobs', per: 25 }
export const RECENT_SCOPE: JobsScope = { base: '/', prefix: 'j_', id: 'recent', per: 10 }
/** Overview picker sizes; `all` pages through everything at `JOBS_PER_MAX` rows, never one unbounded list. */
export const RECENT_PER_OPTIONS = [10, 20, 50] as const

/** One rendered list: the rows of this page, the filter, the position and the total the filter matches. */
export type JobsView = { jobs: Job[]; filter: JobsFilter; page: number; per: number; total: number; runnerNames: RunnerNames }

export const JOB_STATUSES: JobStatus[] = ['queued', 'claimed', 'in_progress', 'completed', 'ignored']

const STATUS_LABEL: Record<JobStatus, string> = { queued: 'Queued', claimed: 'Claimed', in_progress: 'In progress', completed: 'Completed', ignored: 'Ignored' }

const HOUR_MS = 3_600_000
/** Quick time filters: label, span, and how far a stored `since` may drift from "now minus span" and still count as pressed. */
const SINCE_PRESETS: { key: string; label: string; ms: number }[] = [
  { key: '24h', label: 'Last 24 h', ms: 24 * HOUR_MS },
  { key: '7d', label: 'This week', ms: 7 * 24 * HOUR_MS },
]
const PRESET_TOLERANCE_MS = 10 * 60_000

/** Query string for a filter plus paging under the scope's prefix; page 1 and the default page size stay out of the URL. */
export const jobsQuery = (scope: JobsScope, f: JobsFilter, paging: { page?: number; per?: number } = {}) => {
  const q = new URLSearchParams()
  const set = (k: string, v: string) => q.set(scope.prefix + k, v)
  if (f.repo) set('repo', f.repo)
  if (f.status) set('status', f.status)
  if (f.q) set('q', f.q)
  if (f.since) set('since', f.since)
  if (f.running) set('running', '1')
  if (f.failed) set('failed', '1')
  if (f.runner) set('runner', f.runner)
  if (paging.per !== undefined && paging.per !== scope.per) set('per', String(paging.per))
  if (paging.page !== undefined && paging.page > 1) set('page', String(paging.page))
  const s = q.toString()
  return s ? `?${s}` : ''
}

const href = (scope: JobsScope, f: JobsFilter, paging: { page?: number; per?: number } = {}) => `${scope.base}${jobsQuery(scope, f, paging)}`

const isFiltered = (f: JobsFilter) => Boolean(f.repo || f.status || f.q || f.since || f.running || f.failed || f.runner)

const duration = (job: Job) => {
  if (!job.startedAt) return null
  const end = job.completedAt ? new Date(job.completedAt).getTime() : Date.now()
  const s = Math.max(0, Math.round((end - new Date(job.startedAt).getTime()) / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}

/** Status and repo selects, the search box and the runner chip on the left; the quick filters on the right. */
export const JobsToolbar = ({ scope, filter, repos, per }: { scope: JobsScope; filter: JobsFilter; repos: Repo[]; per: number }) => {
  const now = Date.now()
  const sinceMs = filter.since ? Date.parse(filter.since) : NaN
  const pressed = (ms: number) => !Number.isNaN(sinceMs) && Math.abs(now - ms - sinceMs) <= PRESET_TOLERANCE_MS
  // A filter change starts over at page 1 but keeps the page size.
  const toggle = (patch: Partial<JobsFilter>, on: boolean) => href(scope, { ...filter, ...(on ? Object.fromEntries(Object.keys(patch).map((k) => [k, undefined])) : patch) }, { per })
  return (
    <div class="t-toolbar jobs-toolbar" role="toolbar" aria-label="Job filters">
      <select class="t-select" data-size="sm" data-width="auto" aria-label="Status" data-nav={`${scope.prefix}status`} data-nav-reset={`${scope.prefix}page`} id={`${scope.id}-status`}>
        <option value="" selected={!filter.status}>
          All statuses
        </option>
        {JOB_STATUSES.map((s) => (
          <option value={s} selected={filter.status === s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      <select class="t-select" data-size="sm" data-width="auto" aria-label="Repo" data-nav={`${scope.prefix}repo`} data-nav-reset={`${scope.prefix}page`} id={`${scope.id}-repo`}>
        <option value="" selected={!filter.repo}>
          All repos
        </option>
        {[...new Set([...repos.map((r) => r.fullName), ...(filter.repo ? [filter.repo] : [])])].sort().map((name) => (
          <option value={name} selected={filter.repo === name} safe>
            {name}
          </option>
        ))}
      </select>
      <input
        class="t-input"
        data-size="sm"
        data-width="auto"
        type="search"
        id={`${scope.id}-search`}
        name={`${scope.prefix}q`}
        data-nav={`${scope.prefix}q`}
        data-nav-on="enter"
        data-nav-reset={`${scope.prefix}page`}
        placeholder="Search jobs…"
        aria-label="Search jobs"
        value={filter.q ?? ''}
        autocomplete="off"
      />
      {filter.runner ? (
        <span class="t-badge filter-chip" data-tone="accent" data-variant="outline" id={`${scope.id}-runner-chip`}>
          runner:{' '}
          <span class="t-mono" safe>
            {filter.runner}
          </span>
          <a class="chip-remove" href={href(scope, { ...filter, runner: undefined }, { per })} aria-label={`Clear runner filter ${filter.runner}`} data-tip="Clear runner filter">
            ×
          </a>
        </span>
      ) : null}
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
  )
}

/** The rows of one page, or the empty state for the filter. */
export const JobsTable = ({ scope, jobs, filter, runnerNames }: { scope: JobsScope } & Pick<JobsView, 'jobs' | 'filter' | 'runnerNames'>) => {
  if (jobs.length === 0) {
    const filtered = isFiltered(filter)
    return (
      <Empty
        icon="bi-briefcase"
        title={filtered ? 'No jobs match this filter' : 'No jobs yet'}
        text={filtered ? 'Clear the filters to see every job in the retention window.' : 'Jobs arrive through the GitHub webhook as soon as an adopted repo queues a workflow job.'}
      >
        {filtered ? (
          <a class="t-btn" href={scope.base}>
            Clear filters
          </a>
        ) : (
          <a class="t-btn" data-variant="primary" href="/repos">
            Adopt a repo
          </a>
        )}
      </Empty>
    )
  }
  return (
    <div class="t-table-wrap">
      <table class="t-table" data-variant="data" data-density="compact" id={`${scope.id}-table`}>
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
                  <a href={href(scope, { ...filter, repo: j.repo })} safe>
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

/** Page numbers around the current one: first, last, current ±1, with `null` where pages are skipped. */
export const pageWindow = (page: number, pages: number): (number | null)[] => {
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages))
  const out: (number | null)[] = []
  for (let n = 1; n <= pages; n++) {
    if (keep.has(n)) out.push(n)
    else if (out[out.length - 1] !== null) out.push(null)
  }
  return out
}

/**
 * `« 1 2 … 9 »` plus the range in view. `showAll` (Overview) offers a picker (Last 10/20/50, All = `JOBS_PER_MAX`
 * rows per page and keeps paging; `perSelect` (`/jobs`) offers the page sizes as a select. Nothing renders when
 * every job fits on one page of the default size.
 */
export const JobsPager = ({ scope, view, showAll, perSelect }: { scope: JobsScope; view: JobsView; showAll?: boolean; perSelect?: boolean }) => {
  const { filter, page, per, total } = view
  const pages = Math.max(1, Math.ceil(total / per))
  if (total <= scope.per && per === scope.per && !perSelect && !showAll) return null
  const link = (n: number) => href(scope, filter, { page: n, per })
  const first = total === 0 ? 0 : (page - 1) * per + 1
  const last = Math.min(total, page * per)
  return (
    <div class="t-cluster jobs-pager" data-gap="3" data-align="center" id={`${scope.id}-pager`}>
      <nav class="t-pagination" aria-label="Pages" data-size="sm">
        <ul>
          <li>
            {page > 1 ? (
              <a class="t-page-link" href={link(page - 1)} aria-label="Previous page">
                «
              </a>
            ) : (
              <a class="t-page-link" aria-disabled="true" aria-label="Previous page">
                «
              </a>
            )}
          </li>
          {pageWindow(page, pages).map((n) =>
            n === null ? (
              <li>
                <a class="t-page-link" aria-disabled="true">
                  …
                </a>
              </li>
            ) : (
              <li>
                <a class="t-page-link" href={link(n)} aria-current={n === page ? 'page' : undefined}>
                  {String(n)}
                </a>
              </li>
            ),
          )}
          <li>
            {page < pages ? (
              <a class="t-page-link" href={link(page + 1)} aria-label="Next page">
                »
              </a>
            ) : (
              <a class="t-page-link" aria-disabled="true" aria-label="Next page">
                »
              </a>
            )}
          </li>
        </ul>
      </nav>
      <span class="t-muted t-small jobs-pager-range">{total === 0 ? 'no jobs' : `${first}–${last} of ${total}`}</span>
      {showAll ? (
        <select class="t-select" data-size="xs" data-width="auto" aria-label="Jobs shown" data-nav={`${scope.prefix}per`} data-nav-reset={`${scope.prefix}page`} id={`${scope.id}-per`}>
          {RECENT_PER_OPTIONS.map((n) => (
            <option value={String(n)} selected={per === n}>
              {`Last ${n}`}
            </option>
          ))}
          <option value="all" selected={per === JOBS_PER_MAX}>
            All
          </option>
        </select>
      ) : null}
      {perSelect ? (
        <select class="t-select" data-size="xs" data-width="auto" aria-label="Jobs per page" data-nav={`${scope.prefix}per`} data-nav-reset={`${scope.prefix}page`} id={`${scope.id}-per`}>
          {JOBS_PER_PAGE.map((n) => (
            <option value={String(n)} selected={per === n}>
              {`${n} per page`}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  )
}

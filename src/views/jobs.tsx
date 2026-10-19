import type { Job, JobStatus, Repo } from '../lib/types'
import { Empty, Icon, JobBadge, RelTime } from './parts'

export type JobsFilter = { repo?: string; status?: JobStatus }
export type JobsData = { jobs: Job[]; repos: Repo[]; filter: JobsFilter }

export const JOB_STATUSES: JobStatus[] = ['queued', 'claimed', 'in_progress', 'completed', 'ignored']

const query = (f: JobsFilter) => {
  const q = new URLSearchParams()
  if (f.repo) q.set('repo', f.repo)
  if (f.status) q.set('status', f.status)
  const s = q.toString()
  return s ? `?${s}` : ''
}

const duration = (job: Job) => {
  if (!job.startedAt) return null
  const end = job.completedAt ? new Date(job.completedAt).getTime() : Date.now()
  const s = Math.max(0, Math.round((end - new Date(job.startedAt).getTime()) / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}

/** The table block: re-fetched by `app.js` on `job` events (`GET /jobs?…&partial=1`). */
export const JobsTable = ({ jobs, filter }: Pick<JobsData, 'jobs' | 'filter'>) => {
  if (jobs.length === 0) {
    const filtered = Boolean(filter.repo || filter.status)
    return (
      <div id="jobs-live" data-live="job">
        <Empty
          icon="bi-briefcase"
          title={filtered ? 'No jobs match this filter' : 'No jobs yet'}
          text={filtered ? 'Clear the filter to see every job in the retention window.' : 'Jobs arrive through the GitHub webhook as soon as an adopted repo queues a workflow job.'}
        >
          {filtered ? (
            <a class="t-btn" href="/jobs">
              Clear filter
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
            <th data-sort="status">
              <button>
                Status <span class="t-sort-icon"></span>
              </button>
            </th>
            <th data-sort="repo">
              <button>
                Repo <span class="t-sort-icon"></span>
              </button>
            </th>
            <th>Job</th>
            <th>Labels</th>
            <th>Runner</th>
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
          {jobs.map((j) => (
            <tr
              data-job-id={String(j.id)}
              data-status={j.status}
              data-repo={j.repo}
              data-queued={j.queuedAt}
              data-tone={j.status === 'completed' && j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'cancelled' && j.conclusion !== 'skipped' ? 'danger' : undefined}
            >
              <td>
                <JobBadge status={j.status} conclusion={j.conclusion} />
              </td>
              <td>
                <a href={`/jobs?repo=${encodeURIComponent(j.repo)}`} safe>
                  {j.repo}
                </a>
              </td>
              <td safe>{j.name}</td>
              <td>
                {j.labels.map((l) => (
                  <span class="t-badge" data-tone="neutral" data-variant="outline" data-size="xs" safe>
                    {l}
                  </span>
                ))}
              </td>
              <td>{j.runnerId ? <span class="t-mono">{`#${j.runnerId}`}</span> : <span class="t-muted">–</span>}</td>
              <td>
                <RelTime at={j.queuedAt} />
              </td>
              <td class="t-col-num">{duration(j) ?? <span class="t-muted">–</span>}</td>
              <td class="t-col-actions">
                <a class="t-btn" data-size="sm" data-variant="ghost" data-icon="only" href={j.htmlUrl} target="_blank" rel="noopener" data-tip="Open run on GitHub" aria-label="Open run on GitHub">
                  <Icon id="bi-box-arrow-up-right" />
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export const JobsPage = ({ jobs, repos, filter }: JobsData) => (
  <>
    <header class="t-page-header">
      <h1 class="t-page-title">Jobs</h1>
      <span class="t-page-lead">Queue and history. Filter by repo and status.</span>
    </header>
    <div class="t-toolbar page-toolbar" role="toolbar" aria-label="Job filters">
      <div class="t-btn-group" role="group" data-role="filter" aria-label="Status">
        <a class="t-btn" data-size="sm" href={`/jobs${query({ repo: filter.repo })}`} aria-pressed={filter.status ? 'false' : 'true'}>
          All
        </a>
        {JOB_STATUSES.map((s) => (
          <a class="t-btn" data-size="sm" href={`/jobs${query({ repo: filter.repo, status: s })}`} aria-pressed={filter.status === s ? 'true' : 'false'}>
            {s.replace('_', ' ')}
          </a>
        ))}
      </div>
      <span class="t-toolbar-spacer"></span>
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
    </div>
    <JobsTable jobs={jobs} filter={filter} />
  </>
)

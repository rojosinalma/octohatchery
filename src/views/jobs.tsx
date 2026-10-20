import type { Repo } from '../lib/types'
import { JOBS_SCOPE, JobsPager, JobsTable, JobsToolbar, type JobsView } from './jobs-table'

export type { JobsFilter, RunnerNames } from './jobs-table'
export { JOB_STATUSES } from './jobs-table'
export type JobsData = JobsView & { repos: Repo[] }

/** The live block: table and pager together, re-fetched by `app.js` on `job` events (`GET /jobs?…&partial=1`). */
export const JobsLive = (view: JobsView) => (
  <div id="jobs-live" data-live="job" class="t-stack" data-gap="3">
    <JobsTable scope={JOBS_SCOPE} jobs={view.jobs} filter={view.filter} runnerNames={view.runnerNames} />
    <JobsPager scope={JOBS_SCOPE} view={view} perSelect />
  </div>
)

export const JobsPage = ({ repos, ...view }: JobsData) => (
  <>
    <header class="t-page-header">
      <h1 class="t-page-title">Jobs</h1>
      <span class="t-page-lead">Queue and history. Filter by status, repo or text; the quick filters narrow it further.</span>
    </header>
    <div class="page-toolbar">
      <JobsToolbar scope={JOBS_SCOPE} filter={view.filter} repos={repos} per={view.per} />
    </div>
    <JobsLive {...view} />
  </>
)

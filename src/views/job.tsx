import type { Job, JobLog, Runner } from '../lib/types'
import { Icon, JobBadge, RelTime, RunnerBadge, e } from './parts'

export type JobData = { job: Job; runner: Runner | null; log: JobLog }

/** Lines the page renders and the browser keeps; older ones scroll out of the DOM while live. */
export const LOG_DOM_LINES = 5000

const duration = (job: Job) => {
  if (!job.startedAt) return null
  const end = job.completedAt ? new Date(job.completedAt).getTime() : Date.now()
  const s = Math.max(0, Math.round((end - new Date(job.startedAt).getTime()) / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}

/** `2026-01-02T03:04:05.123456789Z` → `03:04:05` for the gutter; the full stamp stays in `data-at`. */
const clock = (at: string) => {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(at)
  return m ? m[1]! : at
}

export const SourceBadge = ({ log }: { log: JobLog }) => {
  if (log.source === 'github')
    return (
      <span class="t-badge" data-tone="accent" id="log-source" data-tip="The log GitHub stores for this job: complete and authoritative">
        <Icon id="bi-github" size="xs" /> source: GitHub
      </span>
    )
  if (log.source === 'runner')
    return (
      <span class="t-badge" data-tone="neutral" id="log-source" data-tip="Captured from the runner container; GitHub did not hand out its log in time">
        source: runner
      </span>
    )
  return (
    <span class="t-badge" data-tone={log.complete ? 'neutral' : 'success'} id="log-source" data-tip={log.complete ? 'No log was collected for this job' : 'Captured from the runner container as it prints'}>
      {log.complete ? 'source: none' : 'source: runner (live)'}
    </span>
  )
}

/** Terminal colour sequences carry nothing for the reader; GitHub strips them in its viewer too. */
export const plainText = (line: string) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

export const LogLines = ({ lines }: { lines: JobLog['lines'] }) => (
  <>
    {lines.map((l) => (
      <span class="log-line" data-seq={String(l.seq)} data-at={l.at}>
        <span class="log-time" safe>
          {clock(l.at)}
        </span>
        <span class="log-text" safe>
          {plainText(l.line)}
        </span>
        {'\n'}
      </span>
    ))}
  </>
)

export const JobPage = ({ job, runner, log }: JobData) => {
  const shown = log.lines.slice(-LOG_DOM_LINES)
  const lastSeq = shown.length ? shown[shown.length - 1]!.seq : 0
  const live = !log.complete
  return (
    <>
      <header class="t-page-header">
        <a class="t-page-back" href="/jobs" aria-label="Back to jobs">
          ←
        </a>
        <h1 class="t-page-title" safe>
          {job.name}
        </h1>
        <span class="t-page-lead">
          <a href={`/jobs?repo=${encodeURIComponent(job.repo)}`} safe>
            {job.repo}
          </a>
          {' · '}
          <JobBadge status={job.status} conclusion={job.conclusion} />
        </span>
        <div class="t-page-actions">
          <a class="t-btn" data-size="sm" href={job.htmlUrl} target="_blank" rel="noopener">
            <Icon id="bi-box-arrow-up-right" /> Run on GitHub
          </a>
        </div>
      </header>

      <section class="t-section">
        <dl class="t-facts job-facts">
          <dt>Runner</dt>
          <dd>
            {runner ? (
              <>
                <span class="t-mono" safe>
                  {runner.name}
                </span>{' '}
                <RunnerBadge state={runner.state} />
              </>
            ) : (
              <span class="t-muted">{job.status === 'queued' ? 'waiting for a free slot' : '–'}</span>
            )}
          </dd>
          <dt>Host / template</dt>
          <dd>
            {runner ? (
              <>
                <span class="t-mono" safe>
                  {runner.host}
                </span>
                {' / '}
                <a href="/templates" class="t-mono" safe>
                  {runner.type}
                </a>
              </>
            ) : (
              <span class="t-muted">–</span>
            )}
          </dd>
          <dt>Labels</dt>
          <dd>
            {job.labels.map((l) => (
              <span class="t-badge" data-tone="neutral" data-variant="outline" data-size="xs" safe>
                {l}
              </span>
            ))}
          </dd>
          <dt>Queued</dt>
          <dd>
            <RelTime at={job.queuedAt} />
          </dd>
          <dt>Started</dt>
          <dd>
            <RelTime at={job.startedAt} />
          </dd>
          <dt>Finished</dt>
          <dd>
            <RelTime at={job.completedAt} />
            {duration(job) ? <span class="t-muted t-small">{e(` (${duration(job)})`)}</span> : null}
          </dd>
        </dl>
      </section>

      <section class="t-section" id="log" data-job-id={String(job.id)} data-last-seq={String(lastSeq)} data-live={live ? 'log' : undefined} data-complete={log.complete ? 'true' : 'false'}>
        <div class="t-toolbar log-toolbar" role="toolbar" aria-label="Log tools">
          <h2 class="t-section-title">Log</h2>
          <SourceBadge log={log} />
          <span class="t-badge" data-tone="warning" id="log-truncated" hidden={!log.truncated} data-tip="The stored log stopped at the size cap (setting log_max_kb); the full log is on GitHub">
            <Icon id="bi-exclamation-triangle" size="xs" /> truncated
          </span>
          <span class="t-toolbar-spacer"></span>
          <span class="t-muted t-small" id="log-count" data-tip="Lines in view">
            {e(`${shown.length} lines`)}
          </span>
          <button class="t-btn" data-size="sm" data-action="log-follow" aria-pressed={live ? 'true' : 'false'} disabled={!live} data-tip={live ? 'Keep the newest lines in view' : 'The log is complete'}>
            <Icon id="bi-arrow-down-circle" /> Follow
          </button>
          <button class="t-btn" data-size="sm" data-action="log-copy" data-tip="Copy every line in view to the clipboard">
            <Icon id="bi-copy" /> Copy
          </button>
        </div>
        <div class="t-empty log-empty" id="log-empty" hidden={shown.length > 0}>
          <span class="t-icon t-empty-icon">
            <Icon id={log.complete ? 'bi-file-earmark-x' : 'bi-hourglass-split'} size="xl" />
          </span>
          <h3 class="t-empty-title">{log.complete ? 'No log stored for this job' : 'Waiting for the runner to start…'}</h3>
          <p>{log.complete ? 'The job finished without a runner on this cluster, or its log was purged.' : 'Lines appear here as soon as the runner prints its first step.'}</p>
        </div>
        <pre class="t-code-pre log-view" id="log-view" tabindex="0" aria-label="Job log" aria-live="off" hidden={shown.length === 0}>
          <LogLines lines={shown} />
        </pre>
      </section>
    </>
  )
}

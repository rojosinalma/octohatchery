import type { Job, JobLog, Runner } from '../lib/types'
import { formatDuration, groupCount, groupDurationMs, groupLines, groupOpen, plainText, type GroupedLine, type LogGroup } from './log-groups'
import { commandText, elapsed, outcomeVerb, shortDuration, stepBlocks, stepDurationMs, stepIcon, type StepBlock } from './log-steps'
import { Icon, JobBadge, RelTime, RunnerBadge, e } from './parts'

export type JobData = { job: Job; runner: Runner | null; log: JobLog; raw?: boolean }
export { plainText }

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

/**
 * One stored line. In the steps view (`base` given) the gutter shows `mm:ss` since the job started with the absolute
 * stamp on hover, and `##[command]` lines render as commands with the marker stripped; the raw view shows the clock.
 */
const LogLine = ({ line, tone, marker, base }: GroupedLine & { base?: string | null }) => {
  const cmd = base !== undefined ? commandText(line.line) : null
  return (
    <span class="log-line" data-seq={String(line.seq)} data-at={line.at} data-tone={tone} data-marker={marker ? '' : undefined} data-cmd={cmd !== null ? '' : undefined} hidden={marker}>
      <span class="log-time" data-tip={base !== undefined ? line.at : undefined} safe>
        {base !== undefined ? elapsed(line.at, base) : clock(line.at)}
      </span>
      <span class="log-text" safe>
        {cmd ?? plainText(line.line)}
      </span>
      {'\n'}
    </span>
  )
}

/** One collapsible group: the summary carries title, line count and span; the marker lines stay in the DOM, hidden, so Copy keeps them. */
const LogGroupBlock = ({ group, base }: { group: LogGroup; base?: string | null }) => {
  const first = group.lines[0]!
  return (
    <details class="log-group" open={groupOpen(group)} data-tone={group.tone} data-closed={group.closed ? '' : undefined} data-first={first.line.at} data-count={String(groupCount(group))}>
      <summary class="log-summary">
        <span class="log-time" data-tip={base !== undefined ? first.line.at : undefined} safe>
          {base !== undefined ? elapsed(first.line.at, base) : clock(first.line.at)}
        </span>
        <span class="log-chevron" aria-hidden="true"></span>
        <span class="log-group-title" safe>
          {group.title}
        </span>
        <span class="log-group-meta t-muted">{e(`${groupCount(group)} lines · ${formatDuration(groupDurationMs(group))}`)}</span>
      </summary>
      {group.lines.map((l) => (
        <LogLine {...l} base={base} />
      ))}
    </details>
  )
}

/** Flat view (`?raw=1`): every line as stored, markers included, tones kept. */
export const LogLines = ({ lines }: { lines: JobLog['lines'] }) => (
  <>
    {lines.map((l) => (
      <LogLine line={l} />
    ))}
  </>
)

/** Grouped view: `##[group]` … `##[endgroup]` blocks fold into `<details>`, everything else stays flat. */
export const LogBlocks = ({ lines, base }: { lines: JobLog['lines']; base?: string | null }) => (
  <>
    {groupLines(lines).map((b) => (b.kind === 'group' ? <LogGroupBlock group={b} base={base} /> : <LogLine line={b.line} tone={b.tone} marker={b.marker} base={base} />))}
  </>
)

/** The round status icon of a step row; a running step spins. */
const StepStatus = ({ block }: { block: StepBlock }) => {
  const s = stepIcon(block.step)
  if (s.icon === 'spinner') return <span class="t-spinner log-step-icon" data-size="sm" data-tone="accent" role="img" aria-label="running" data-tip="Running"></span>
  return (
    <span class="log-step-icon" data-tone={s.tone} role="img" aria-label={s.label} data-tip={s.label[0]!.toUpperCase() + s.label.slice(1)}>
      <Icon id={s.icon} size="sm" />
    </span>
  )
}

/**
 * One step: the row carries chevron, status, name, duration and line count; the body holds the step's lines with the
 * `##[group]` folding as a second level. `data-started`/`data-completed` let the browser place streamed lines.
 */
const LogStepBlock = ({ block, base }: { block: StepBlock; base: string | null }) => {
  const { step } = block
  return (
    <details class="log-step" open={block.open} data-number={String(step.number)} data-status={step.status} data-conclusion={step.conclusion ?? undefined} data-started={step.startedAt ?? undefined} data-completed={step.completedAt ?? undefined} data-count={String(block.count)}>
      <summary class="log-step-head">
        <span class="log-step-chevron" aria-hidden="true">
          <Icon id="bi-chevron-right" size="xs" />
        </span>
        <StepStatus block={block} />
        <span class="log-step-name" safe>
          {step.name}
        </span>
        <span class="log-step-count t-muted t-small">{e(`${block.count} lines`)}</span>
        <span class="log-step-duration t-muted" data-tip={step.startedAt ? `${step.startedAt} → ${step.completedAt ?? 'running'}` : undefined}>
          {e(step.startedAt ? shortDuration(stepDurationMs(step)) : '')}
        </span>
      </summary>
      <div class="log-step-body t-code-pre">
        <LogBlocks lines={block.lines} base={base} />
      </div>
    </details>
  )
}

/** Steps view: GitHub's step list with the lines placed by timestamp (one pseudo-step while no steps are known). */
export const LogSteps = ({ job, blocks, lastSeq }: { job: Job; blocks: StepBlock[]; lastSeq: number }) => (
  <div class="log-steps" id="log-view" tabindex="0" aria-label="Job log by step" aria-live="off" data-last-seq={String(lastSeq)} data-started={job.startedAt ?? undefined} hidden={!blocks.some((b) => b.lines.length)}>
    {blocks.map((b) => (
      <LogStepBlock block={b} base={job.startedAt} />
    ))}
  </div>
)

/** Lines the steps view shows: what is left after blank lines and progress runs are removed. */
const shownCount = (blocks: StepBlock[]) => blocks.reduce((n, b) => n + b.lines.length, 0)

/** Status badge next to the repo link; swapped on `job` events together with the outcome line. */
const JobLead = ({ job }: { job: Job }) => (
  <span class="t-page-lead" id="job-lead">
    <a href={`/jobs?repo=${encodeURIComponent(job.repo)}`} safe>
      {job.repo}
    </a>
    {' · '}
    <JobBadge status={job.status} conclusion={job.conclusion} />
  </span>
)

/** "succeeded 12 min ago in 2m 20s": verb, when it ended (or started), how long it took (or has been running). */
export const JobOutcome = ({ job }: { job: Job }) => {
  const verb = outcomeVerb(job)
  const when = job.status === 'completed' ? job.completedAt : (job.startedAt ?? job.queuedAt)
  const took = job.startedAt ? shortDuration(stepDurationMs({ startedAt: job.startedAt, completedAt: job.completedAt })) : null
  return (
    <p class="job-outcome t-muted" id="job-outcome">
      <span safe>{verb}</span> <RelTime at={when} />
      {took ? (
        <>
          {job.status === 'completed' ? ' in ' : ' for '}
          <span class="t-mono" safe>
            {took}
          </span>
        </>
      ) : null}
    </p>
  )
}

/** `?partial=log`: what `public/app.js` swaps on a `job` event — lead, outcome line and the steps view, by id. */
export const JobLive = ({ job, log }: Pick<JobData, 'job' | 'log'>) => {
  const shown = log.lines.slice(-LOG_DOM_LINES)
  const lastSeq = shown.length ? shown[shown.length - 1]!.seq : 0
  return (
    <div id="job-live">
      <JobLead job={job} />
      <JobOutcome job={job} />
      <LogSteps job={job} blocks={stepBlocks(job, shown)} lastSeq={lastSeq} />
    </div>
  )
}

export const JobPage = ({ job, runner, log, raw = false }: JobData) => {
  const shown = log.lines.slice(-LOG_DOM_LINES)
  const lastSeq = shown.length ? shown[shown.length - 1]!.seq : 0
  const live = !log.complete
  const blocks = raw ? [] : stepBlocks(job, shown)
  const lineCount = raw ? shown.length : shownCount(blocks)
  return (
    <>
      <header class="t-page-header">
        <a class="t-page-back" href="/jobs" aria-label="Back to jobs">
          ←
        </a>
        <h1 class="t-page-title" safe>
          {job.name}
        </h1>
        <JobLead job={job} />
        <JobOutcome job={job} />
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
                <a class="t-mono" href={`/jobs?runner=${encodeURIComponent(runner.name)}`} data-tip="Jobs this runner handled" safe>
                  {runner.name}
                </a>{' '}
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
                <a href={`/hosts#${encodeURIComponent(runner.host)}`} class="t-mono" data-tip="Host details" safe>
                  {runner.host}
                </a>
                {' / '}
                <a href={`/templates#${encodeURIComponent(runner.type)}`} class="t-mono" data-tip="Template" safe>
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

      <section class="t-section" id="log" data-job-id={String(job.id)} data-last-seq={String(lastSeq)} data-live={live ? 'log' : undefined} data-complete={log.complete ? 'true' : 'false'} data-raw={raw ? 'true' : undefined} data-live-job={live && !raw ? 'job' : undefined}>
        <div class="t-toolbar log-toolbar" role="toolbar" aria-label="Log tools">
          <h2 class="t-section-title">Log</h2>
          <SourceBadge log={log} />
          <span class="t-badge" data-tone="warning" id="log-truncated" hidden={!log.truncated} data-tip="The stored log stopped at the size cap (setting log_max_kb); the full log is on GitHub">
            <Icon id="bi-exclamation-triangle" size="xs" /> truncated
          </span>
          <span class="t-toolbar-spacer"></span>
          <span class="t-muted t-small" id="log-count" data-tip="Lines in view">
            {e(`${lineCount} lines`)}
          </span>
          <button class="t-btn" data-size="sm" data-action="log-follow" aria-pressed={live ? 'true' : 'false'} disabled={!live} data-tip={live ? 'Keep the newest lines in view' : 'The log is complete'}>
            <Icon id="bi-arrow-down-circle" /> Follow
          </button>
          <button class="t-btn" data-size="sm" data-action="log-copy" data-tip="Copy every line in view to the clipboard, group markers included">
            <Icon id="bi-copy" /> Copy
          </button>
          {raw ? null : (
            <div class="t-btn-group" role="group" aria-label="Steps">
              <button class="t-btn" data-size="sm" data-action="log-expand" data-tip="Open every step">
                <Icon id="bi-arrows-expand" /> Expand all
              </button>
              <button class="t-btn" data-size="sm" data-action="log-collapse" data-tip="Close every step">
                <Icon id="bi-arrows-collapse" /> Collapse all
              </button>
            </div>
          )}
          {raw ? (
            <a class="t-btn" data-size="sm" data-variant="ghost" href={`/jobs/${job.id}`} data-tip="Back to the steps view">
              <Icon id="bi-list-nested" /> Steps
            </a>
          ) : (
            <a class="t-btn" data-size="sm" data-variant="ghost" href={`/jobs/${job.id}?raw=1`} data-tip="Every line as stored: no steps, no groups, blank lines kept">
              <Icon id="bi-text-left" /> Raw
            </a>
          )}
        </div>
        <div class="t-empty log-empty" id="log-empty" hidden={lineCount > 0}>
          <span class="t-icon t-empty-icon">
            <Icon id={log.complete ? 'bi-file-earmark-x' : 'bi-hourglass-split'} size="xl" />
          </span>
          <h3 class="t-empty-title">{log.complete ? 'No log stored for this job' : 'Waiting for the runner to start…'}</h3>
          <p>{log.complete ? 'The job finished without a runner on this cluster, or its log was purged.' : 'Lines appear here as soon as the runner prints its first step.'}</p>
        </div>
        {raw ? (
          <div class="t-code-pre log-view" id="log-view" tabindex="0" aria-label="Job log" aria-live="off" hidden={shown.length === 0}>
            <LogLines lines={shown} />
          </div>
        ) : (
          <LogSteps job={job} blocks={blocks} lastSeq={lastSeq} />
        )}
      </section>
    </>
  )
}

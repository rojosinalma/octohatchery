import type { Job, JobAnnotation, JobLog, Runner } from '../lib/types'
import { ansiSegments } from './log-ansi'
import { formatDuration, groupCount, groupDurationMs, groupOpen, plainText, type GroupedLine, type LogBlock, type LogGroup } from './log-groups'
import { annotationTarget, lineAnchor, lineView, outcomeVerb, shortDuration, stepBlocks, stepDurationMs, stepIcon, type LineView, type StepBlock } from './log-steps'
import { Icon, JobBadge, RelTime, RunnerBadge, e } from './parts'

/** `1 line`, `3 lines`. */
const linesLabel = (n: number) => `${n} ${n === 1 ? 'line' : 'lines'}`

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

/** Flat view (`?raw=1`): every line as stored, markers included, tones kept, the clock in the gutter. */
const RawLine = ({ line, tone }: GroupedLine) => (
  <span class="log-line" data-seq={String(line.seq)} data-at={line.at} data-tone={tone}>
    <span class="log-time" safe>
      {clock(line.at)}
    </span>
    <span class="log-text" safe>
      {plainText(line.line)}
    </span>
    {'\n'}
  </span>
)

/** Flat view (`?raw=1`): every line as stored, markers included, tones kept. */
export const LogLines = ({ lines }: { lines: JobLog['lines'] }) => (
  <>
    {lines.map((l) => (
      <RawLine line={l} />
    ))}
  </>
)

/** Coloured text: each ANSI segment escaped, its classes from the known SGR set only (`log-ansi.ts`). */
export const ansiHtml = (raw: string): string => ansiSegments(raw)
  .map((seg) => (seg.cls ? `<span class="${seg.cls}">${e(seg.text)}</span>` : e(seg.text)))
  .join('')

/** Icon and word GitHub shows in front of an `##[error]`, `##[warning]`, `##[notice]` line; `##[debug]` gets the word only. */
const MARKS: Partial<Record<LineView['kind'], { icon?: string; word: string }>> = {
  danger: { icon: 'bi-x-circle-fill', word: 'Error:' },
  warning: { icon: 'bi-exclamation-triangle', word: 'Warning:' },
  notice: { icon: 'bi-info-circle', word: 'Notice:' },
  debug: { word: 'Debug:' },
}

/** Line number (a link to the line) and the time of day, shown only with timestamps on, the full stamp on hover. */
const Gutter = ({ id, n, at }: { id?: string; n?: number; at: string }) => (
  <>
    {id && n !== undefined ? (
      <a class="log-num" href={`#${id}`} tabindex="-1">
        {String(n)}
      </a>
    ) : (
      <span class="log-num"></span>
    )}
    <time class="log-ts" datetime={at} data-tip={at} safe>
      {clock(at)}
    </time>
  </>
)

/**
 * One line of the steps view: number (the anchor `step-<n>-<line>`), time, the marker's icon and word, the text with
 * its colours. Marker lines (`##[group]`/`##[endgroup]`) stay in the DOM hidden, so Copy keeps them.
 */
const StepLine = ({ line, tone, marker, n, step }: GroupedLine & { step: number }) => {
  const view = lineView(line.line)
  const mark = MARKS[view.kind]
  const id = n !== undefined ? lineAnchor(step, n) : undefined
  return (
    <span class="log-line" id={id} data-seq={String(line.seq)} data-at={line.at} data-n={n !== undefined ? String(n) : undefined} data-tone={tone} data-marker={marker ? '' : undefined} data-cmd={view.kind === 'cmd' ? '' : undefined} hidden={marker}>
      <Gutter id={id} n={n} at={line.at} />
      {mark ? (
        <span class="log-mark">
          {mark.icon ? <Icon id={mark.icon} size="xs" /> : null}
          {e(mark.word)}
        </span>
      ) : null}
      <span class="log-text">{marker ? e(plainText(line.line)) : ansiHtml(view.raw)}</span>
      {'\n'}
    </span>
  )
}

/** One collapsible group: the summary is the group's numbered header line; the marker lines stay in the DOM, hidden. */
const LogGroupBlock = ({ group, step }: { group: LogGroup; step: number }) => {
  const first = group.lines[0]!
  const id = group.n !== undefined ? lineAnchor(step, group.n) : undefined
  return (
    <details class="log-group" open={groupOpen(group)} data-tone={group.tone} data-closed={group.closed ? '' : undefined} data-first={first.line.at} data-count={String(groupCount(group))}>
      <summary class="log-summary" id={id} data-n={group.n !== undefined ? String(group.n) : undefined}>
        <Gutter id={id} n={group.n} at={first.line.at} />
        <span class="log-chevron" aria-hidden="true"></span>
        <span class="log-group-title" safe>
          {group.title}
        </span>
        <span class="log-group-meta t-muted">{e(`${linesLabel(groupCount(group))} · ${formatDuration(groupDurationMs(group))}`)}</span>
      </summary>
      {group.lines.map((l) => (
        <StepLine {...l} step={step} />
      ))}
    </details>
  )
}

/** A step's body: `##[group]` … `##[endgroup]` blocks fold into `<details>`, everything else stays flat. */
const StepBody = ({ blocks, step }: { blocks: LogBlock[]; step: number }) => (
  <>{blocks.map((b) => (b.kind === 'group' ? <LogGroupBlock group={b} step={step} /> : <StepLine {...b} step={step} />))}</>
)

/** Small toned badges on a step row: how many errors and warnings the step printed. */
const StepTally = ({ block }: { block: StepBlock }) => (
  <>
    {block.errors ? (
      <span class="t-badge log-step-tally" data-tone="danger" data-size="xs" data-kind="errors" data-tip={`${block.errors} ${block.errors === 1 ? 'error' : 'errors'}`}>
        <Icon id="bi-x-circle-fill" size="xs" />
        {String(block.errors)}
      </span>
    ) : null}
    {block.warnings ? (
      <span class="t-badge log-step-tally" data-tone="warning" data-size="xs" data-kind="warnings" data-tip={`${block.warnings} ${block.warnings === 1 ? 'warning' : 'warnings'}`}>
        <Icon id="bi-exclamation-triangle" size="xs" />
        {String(block.warnings)}
      </span>
    ) : null}
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
 * One step: the row carries chevron, status, name, error and warning badges, line count and duration; the body holds
 * the step's numbered lines with the `##[group]` folding as a second level. `data-started`/`data-completed` let the
 * browser place streamed lines, `data-next` is the number the next streamed line of the step gets.
 */
const LogStepBlock = ({ block }: { block: StepBlock }) => {
  const { step } = block
  return (
    <details class="log-step" open={block.open} data-number={String(step.number)} data-status={step.status} data-conclusion={step.conclusion ?? undefined} data-started={step.startedAt ?? undefined} data-completed={step.completedAt ?? undefined} data-count={String(block.count)} data-next={String(block.next)}>
      <summary class="log-step-head">
        <span class="log-step-chevron" aria-hidden="true">
          <Icon id="bi-chevron-right" size="xs" />
        </span>
        <StepStatus block={block} />
        <span class="log-step-name" safe>
          {step.name}
        </span>
        <StepTally block={block} />
        <span class="log-step-count t-muted t-small">{e(linesLabel(block.count))}</span>
        <span class="log-step-duration t-muted" data-tip={step.startedAt ? `${step.startedAt} → ${step.completedAt ?? 'running'}` : undefined}>
          {e(step.startedAt ? shortDuration(stepDurationMs(step)) : '')}
        </span>
      </summary>
      <div class="log-step-body t-code-pre">
        <StepBody blocks={block.blocks} step={step.number} />
      </div>
    </details>
  )
}

/** Steps view: GitHub's step list with each step's lines (one pseudo-step while no steps are known). */
export const LogSteps = ({ job, blocks, lastSeq }: { job: Job; blocks: StepBlock[]; lastSeq: number }) => (
  <div class="log-steps" id="log-view" tabindex="0" aria-label="Job log by step" aria-live="off" data-last-seq={String(lastSeq)} data-started={job.startedAt ?? undefined} hidden={!blocks.some((b) => b.lines.length)}>
    {blocks.map((b) => (
      <LogStepBlock block={b} />
    ))}
  </div>
)

const ANNOTATION_LOOK: Record<JobAnnotation['level'], { icon: string; tone: string; label: string }> = {
  failure: { icon: 'bi-x-circle-fill', tone: 'danger', label: 'Error' },
  warning: { icon: 'bi-exclamation-triangle', tone: 'warning', label: 'Warning' },
  notice: { icon: 'bi-info-circle', tone: 'info', label: 'Notice' },
}

/** `path:line` (or `path:start-end`); GitHub's `.github` placeholder for annotations without a file shows nothing. */
const annotationWhere = (a: JobAnnotation): string | null => {
  if (!a.path || a.path === '.github') return null
  if (a.startLine === null) return a.path
  return a.endLine !== null && a.endLine !== a.startLine ? `${a.path}:${a.startLine}-${a.endLine}` : `${a.path}:${a.startLine}`
}

/**
 * The job's check-run annotations above the steps: level icon, title and message, `path:line`. A message that also
 * appears as an error or warning line in the log links to that line. Always in the DOM (hidden when empty) so the
 * live re-render can swap it by id.
 */
export const LogAnnotations = ({ annotations, blocks }: { annotations: JobAnnotation[]; blocks: StepBlock[] }) => (
  <div class="log-annotations" id="log-annotations" hidden={!annotations.length}>
    <h3 class="log-annotations-title">
      Annotations <span class="t-counter">{String(annotations.length)}</span>
    </h3>
    <ul class="log-annotation-list">
      {annotations.map((a) => {
        const look = ANNOTATION_LOOK[a.level]
        const target = annotationTarget(blocks, a)
        const where = annotationWhere(a)
        return (
          <li class="log-annotation" data-level={a.level}>
            <span class="log-annotation-icon" data-tone={look.tone} role="img" aria-label={look.label}>
              <Icon id={look.icon} size="sm" />
            </span>
            <span class="log-annotation-body">
              {a.title ? (
                <b class="log-annotation-title" safe>
                  {a.title}
                </b>
              ) : null}
              {target ? (
                <a class="log-annotation-msg" href={`#${target}`} data-tip="Show the line in the log" safe>
                  {a.message}
                </a>
              ) : (
                <span class="log-annotation-msg" safe>
                  {a.message}
                </span>
              )}
            </span>
            {where ? (
              <span class="log-annotation-where t-mono t-muted t-small" safe>
                {where}
              </span>
            ) : null}
          </li>
        )
      })}
    </ul>
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

/** `?partial=log`: what `public/app.js` swaps on a `job` event — lead, outcome line, annotations and the steps view, by id. */
export const JobLive = ({ job, log }: Pick<JobData, 'job' | 'log'>) => {
  const shown = log.lines.slice(-LOG_DOM_LINES)
  const lastSeq = shown.length ? shown[shown.length - 1]!.seq : 0
  const blocks = stepBlocks(job, shown)
  return (
    <div id="job-live">
      <JobLead job={job} />
      <JobOutcome job={job} />
      <LogAnnotations annotations={job.annotations} blocks={blocks} />
      <LogSteps job={job} blocks={blocks} lastSeq={lastSeq} />
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
            {e(linesLabel(lineCount))}
          </span>
          {raw ? null : (
            <span class="log-search" role="search">
              <input class="t-input" type="search" id="log-search" data-size="sm" data-width="auto" placeholder="Search open steps" aria-label="Search the lines of open steps" autocomplete="off" data-tip="Enter: next match · Shift+Enter: previous" />
              <span class="t-muted t-small" id="log-matches" aria-live="polite" hidden></span>
              <button class="t-btn" data-size="sm" data-variant="ghost" data-icon="only" data-action="log-search-prev" aria-label="Previous match" data-tip="Previous match" disabled>
                <Icon id="bi-chevron-down" />
              </button>
              <button class="t-btn" data-size="sm" data-variant="ghost" data-icon="only" data-action="log-search-next" aria-label="Next match" data-tip="Next match" disabled>
                <Icon id="bi-chevron-down" />
              </button>
            </span>
          )}
          <button class="t-btn" data-size="sm" data-action="log-follow" aria-pressed={live ? 'true' : 'false'} disabled={!live} data-tip={live ? 'Keep the newest lines in view' : 'The log is complete'}>
            <Icon id="bi-arrow-down-circle" /> Follow
          </button>
          <button class="t-btn" data-size="sm" data-action="log-copy" data-tip="Copy every line in view to the clipboard, group markers included">
            <Icon id="bi-copy" /> Copy
          </button>
          {raw ? null : (
            <button class="t-btn" data-size="sm" data-action="log-timestamps" aria-pressed="false" data-tip="Show the time of day of every line (UTC)">
              <Icon id="bi-clock" /> Show timestamps
            </button>
          )}
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
        {raw ? null : <LogAnnotations annotations={job.annotations} blocks={blocks} />}
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

import type { Job, JobAnnotation, JobStep, LogLine } from '../lib/types'
import { classify, groupLines, plainText, type LogBlock } from './log-groups'

/*
 * Steps view of a job log, the way GitHub shows it: one collapsible row per step. A line that carries its step
 * number (GitHub's per-step log files) goes to that step; any other line (live runner output, the flat log when the
 * archive was not available) goes to the step whose time window holds its timestamp. Inside a step lines are
 * numbered from 1 (a group header counts, its hidden markers do not). Pure functions; `src/views/job.tsx` renders the result and
 * `public/app.js` keeps the same rules for lines that arrive over the stream: change one, change the other.
 */

export type StepBlock = {
  step: JobStep
  /** True for the single "Log" step a job without step data gets. */
  pseudo: boolean
  /** Lines after `refineLines` (blanks dropped, progress runs collapsed), in order. */
  lines: LogLine[]
  blocks: LogBlock[]
  count: number
  /** `##[error]` and `##[warning]` lines in the step. */
  errors: number
  warnings: number
  /** Number the next streamed line of this step gets. */
  next: number
  open: boolean
}

export type StepIcon = { icon: 'spinner' | 'bi-check-circle-fill' | 'bi-x-circle-fill' | 'bi-slash-circle' | 'bi-dash-circle'; tone: 'success' | 'danger' | 'muted' | 'accent'; label: string }

/** Ms since epoch of an ISO stamp, or NaN. GitHub's 7-digit fractions parse fine; the comparison is at ms precision. */
export const ms = (at: string | null | undefined): number => (at ? Date.parse(at) : NaN)

/** Download and transfer progress GitHub prints line by line; only the last of a run is worth keeping. */
const PROGRESS_RE = /^(?:Received \d+ of \d+|\d{1,3}(?:\.\d+)?%(?:\s|$)|.*\b\d{1,3}(?:\.\d+)?% \(\d+\/\d+\))/
export const isProgress = (line: string): boolean => PROGRESS_RE.test(plainText(line).trim())

/** What a line shows: the marker kind and the text with the marker (`##[error]`, `[command]`, …) taken out, ANSI kept. */
export type LineView = { kind: 'text' | 'cmd' | 'danger' | 'warning' | 'notice' | 'debug'; raw: string }

const SHOWN_MARKER_RE = /^(##\[(?:error|warning|notice|debug|command)\]|\[command\])/
const MARKER_KIND: Record<string, LineView['kind']> = { '##[error]': 'danger', '##[warning]': 'warning', '##[notice]': 'notice', '##[debug]': 'debug', '##[command]': 'cmd', '[command]': 'cmd' }

export const lineView = (raw: string): LineView => {
  const m = SHOWN_MARKER_RE.exec(plainText(raw))
  if (!m) return { kind: 'text', raw }
  // The marker may sit behind colour codes: drop its first occurrence from the raw text, keep the codes.
  const i = raw.indexOf(m[1]!)
  return { kind: MARKER_KIND[m[1]!]!, raw: i >= 0 ? raw.slice(0, i) + raw.slice(i + m[1]!.length) : raw }
}

/** `##[command]text` and `[command]text` → `text`; anything else → null. */
export const commandText = (line: string): string | null => {
  const m = /^(?:##)?\[command\](.*)$/.exec(plainText(line))
  return m ? m[1]! : null
}

/** Drops blank lines and collapses a run of consecutive progress lines to its last one. */
export const refineLines = (lines: LogLine[]): LogLine[] => {
  const out: LogLine[] = []
  for (const l of lines) {
    const text = plainText(l.line)
    if (text.trim() === '') continue
    if (isProgress(text) && out.length && isProgress(out[out.length - 1]!.line)) out[out.length - 1] = l
    else out.push(l)
  }
  return out
}

/** The one step a job without step data shows: it runs with the job and takes the job's outcome. */
export const pseudoStep = (job: Pick<Job, 'status' | 'conclusion' | 'startedAt' | 'completedAt'>): JobStep => ({
  number: 0,
  name: 'Log',
  status: job.status === 'completed' ? 'completed' : job.status === 'in_progress' ? 'in_progress' : 'queued',
  conclusion: job.status === 'completed' ? job.conclusion : null,
  startedAt: job.startedAt,
  completedAt: job.completedAt,
})

/**
 * Lines the runner prints first in a step: `##[group]Run <action or script>` for every main step, `Post job cleanup.`
 * for a post step, `Cleaning up orphan processes` for "Complete job". Only a line like this moves to the next step
 * inside the second that step started in.
 */
const OPENER_RE = /^(?:##\[group\](Run .*)|Post job cleanup\.|Cleaning up orphan processes)\s*$/

/** The group title when `line` opens a step (`Run actions/checkout@v7`), '' for the other openers, null otherwise. */
export const stepOpener = (line: string): string | null => {
  const m = OPENER_RE.exec(plainText(line))
  return m ? (m[1] ?? '').trim() : null
}

/**
 * Lines → steps, keeping GitHub's order (`number`). A line that carries its step (GitHub's per-step files) goes to
 * that step. Every other line is placed by time, never going back to an earlier step: GitHub's step times are cut
 * to the second, so a step's own last lines and the next steps' starts often share one second. Inside that second
 * the current step keeps its lines until a step opener (`stepOpener`) shows up, which moves on to the started step
 * whose name matches the opener (`Run actions/checkout@v7`) or else the next started one; a stamp one second or more
 * past a step's start moves on to that step in any case. Skipped steps print nothing and take no lines. Lines before
 * the first step go to the first step, lines without a readable stamp follow the line before them, and a
 * `##[endgroup]` stays with the step that opened its group.
 */
export const assignLines = (steps: JobStep[], lines: LogLine[]): Map<number, LogLine[]> => {
  const ordered = [...steps].sort((a, b) => a.number - b.number)
  const out = new Map<number, LogLine[]>(ordered.map((s) => [s.number, []]))
  if (!ordered.length) return out
  const starts = ordered.map((s) => (s.conclusion === 'skipped' ? NaN : ms(s.startedAt)))
  let current = 0
  let groupStep: number | null = null
  for (const line of lines) {
    if (line.step != null && out.has(line.step)) {
      // GitHub said which step printed it: no timestamp guess, no group carried across steps.
      out.get(line.step)!.push(line)
      current = Math.max(current, ordered.findIndex((s) => s.number === line.step))
      groupStep = null
      continue
    }
    const marker = classify(line.line)
    if (marker.kind === 'close' && groupStep !== null) {
      out.get(groupStep)!.push(line)
      groupStep = null
      continue
    }
    const at = ms(line.at)
    if (!Number.isNaN(at)) {
      // A whole second past a later step's start: that step runs, whatever the line says.
      for (let i = current + 1; i < ordered.length; i++) if (starts[i]! + 1000 <= at) current = i
      const opener = stepOpener(line.line)
      if (opener !== null) {
        const started: number[] = []
        for (let i = current + 1; i < ordered.length; i++) if (starts[i]! <= at) started.push(i)
        const named = opener ? started.find((i) => ordered[i]!.name === opener) : undefined
        if (named !== undefined) current = named
        else if (started.length) current = started[0]!
      }
    }
    const number = ordered[current]!.number
    out.get(number)!.push(line)
    if (marker.kind === 'open') groupStep = number
    else if (marker.kind === 'close') groupStep = null
  }
  return out
}

/** A step opens by default while it runs or when it failed; everything else starts collapsed. */
export const stepOpen = (step: JobStep): boolean => step.status === 'in_progress' || step.conclusion === 'failure'

export const stepIcon = (step: JobStep): StepIcon => {
  if (step.status === 'in_progress') return { icon: 'spinner', tone: 'accent', label: 'running' }
  if (step.status !== 'completed') return { icon: 'bi-dash-circle', tone: 'muted', label: 'queued' }
  switch (step.conclusion) {
    case 'success':
      return { icon: 'bi-check-circle-fill', tone: 'success', label: 'succeeded' }
    case 'failure':
    case 'timed_out':
    case 'action_required':
      return { icon: 'bi-x-circle-fill', tone: 'danger', label: step.conclusion === 'failure' ? 'failed' : step.conclusion.replace('_', ' ') }
    case 'cancelled':
      return { icon: 'bi-slash-circle', tone: 'muted', label: 'cancelled' }
    case 'skipped':
      return { icon: 'bi-slash-circle', tone: 'muted', label: 'skipped' }
    default:
      return { icon: 'bi-dash-circle', tone: 'muted', label: step.conclusion ?? 'unknown' }
  }
}

/** Ms a step took; a running step counts up to `nowMs`; unknown start → 0. */
export const stepDurationMs = (step: Pick<JobStep, 'startedAt' | 'completedAt'>, nowMs = Date.now()): number => {
  const a = ms(step.startedAt)
  if (Number.isNaN(a)) return 0
  const b = ms(step.completedAt)
  return Math.max(0, (Number.isNaN(b) ? nowMs : b) - a)
}

/** `0s`, `12s`, `2m 20s`, `1h 2m`: GitHub's compact shape for step rows and the outcome line. */
export const shortDuration = (durationMs: number): string => {
  const s = Math.round(durationMs / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** `mm:ss` since `baseAt` (`h:mm:ss` past an hour); a stamp before the base or an unreadable one reads `00:00`. */
export const elapsed = (at: string, baseAt: string | null): string => {
  const a = ms(at)
  const b = ms(baseAt)
  const s = Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.max(0, Math.floor((a - b) / 1000))
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`
}

/** `succeeded`, `failed`, `cancelled`, `running`, `queued`, …: the verb of the outcome line under the title. */
export const outcomeVerb = (job: Pick<Job, 'status' | 'conclusion'>): string => {
  if (job.status === 'completed') {
    switch (job.conclusion) {
      case 'success':
        return 'succeeded'
      case 'failure':
        return 'failed'
      case null:
        return 'finished'
      default:
        return job.conclusion.replace(/_/g, ' ')
    }
  }
  if (job.status === 'in_progress') return 'running'
  if (job.status === 'claimed') return 'starting'
  return job.status
}

/**
 * Numbers the visible lines of one step from 1, in order: a group's header takes the number of its `##[group]` line,
 * content lines count, hidden markers do not. Returns the number the next line gets.
 */
export const numberBlocks = (blocks: LogBlock[]): number => {
  let n = 1
  for (const b of blocks) {
    if (b.kind === 'group') {
      b.n = n++
      for (const l of b.lines) if (!l.marker) l.n = n++
    } else if (!b.marker) b.n = n++
  }
  return n
}

/** The whole steps view: steps in order, each with its refined lines, numbered folded groups, counts and open state. */
export const stepBlocks = (job: Job, lines: LogLine[]): StepBlock[] => {
  const pseudo = job.steps.length === 0
  const steps = pseudo ? [pseudoStep(job)] : [...job.steps].sort((a, b) => a.number - b.number)
  const refined = refineLines(lines)
  const byStep = assignLines(steps, refined)
  return steps.map((step) => {
    const own = byStep.get(step.number) ?? []
    const blocks = groupLines(own)
    const next = numberBlocks(blocks)
    const tones = own.map((l) => classify(l.line))
    const count = tones.filter((m) => m.kind === 'line').length
    const errors = tones.filter((m) => m.kind === 'line' && m.tone === 'danger').length
    const warnings = tones.filter((m) => m.kind === 'line' && m.tone === 'warning').length
    return { step, pseudo, lines: own, blocks, count, errors, warnings, next, open: stepOpen(step) }
  })
}

/** Anchor id of line `n` of step `step`: `step-4-12`. */
export const lineAnchor = (step: number, n: number): string => `step-${step}-${n}`

/**
 * The line an annotation points at in the log: the first error or warning line (matching the annotation's level)
 * whose text holds the annotation's first message line. Null when none does.
 */
export const annotationTarget = (blocks: StepBlock[], a: Pick<JobAnnotation, 'level' | 'message'>): string | null => {
  const needle = a.message.split('\n')[0]!.trim()
  if (!needle) return null
  const tone = a.level === 'failure' ? 'danger' : a.level
  for (const b of blocks) {
    const lines = b.blocks.flatMap((x) => (x.kind === 'group' ? x.lines : [x]))
    for (const l of lines) if (l.tone === tone && l.n !== undefined && plainText(l.line.line).includes(needle)) return lineAnchor(b.step.number, l.n)
  }
  return null
}

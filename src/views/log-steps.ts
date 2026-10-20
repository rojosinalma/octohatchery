import type { Job, JobStep, LogLine } from '../lib/types'
import { classify, groupLines, plainText, type LogBlock } from './log-groups'

/*
 * Steps view of a job log, the way GitHub shows it: one collapsible row per step, the lines placed under the step
 * whose time window holds their timestamp. Pure functions; `src/views/job.tsx` renders the result and
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
  open: boolean
}

export type StepIcon = { icon: 'spinner' | 'bi-check-circle-fill' | 'bi-x-circle-fill' | 'bi-slash-circle' | 'bi-dash-circle'; tone: 'success' | 'danger' | 'muted' | 'accent'; label: string }

/** Ms since epoch of an ISO stamp, or NaN. GitHub's 7-digit fractions parse fine; the comparison is at ms precision. */
export const ms = (at: string | null | undefined): number => (at ? Date.parse(at) : NaN)

/** Download and transfer progress GitHub prints line by line; only the last of a run is worth keeping. */
const PROGRESS_RE = /^(?:Received \d+ of \d+|\d{1,3}(?:\.\d+)?%(?:\s|$)|.*\b\d{1,3}(?:\.\d+)?% \(\d+\/\d+\))/
export const isProgress = (line: string): boolean => PROGRESS_RE.test(plainText(line).trim())

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
 * Each line goes to the last step whose `startedAt` is at or before its stamp; lines before the first started step go
 * to the first step, lines without a readable stamp follow the line before them. A `##[endgroup]` stays with the step
 * that opened its group even when its stamp already falls in the next step (GitHub's second-precision step times cut
 * through the last group of a step). Steps keep GitHub's order (`number`).
 */
export const assignLines = (steps: JobStep[], lines: LogLine[]): Map<number, LogLine[]> => {
  const ordered = [...steps].sort((a, b) => a.number - b.number)
  const out = new Map<number, LogLine[]>(ordered.map((s) => [s.number, []]))
  if (!ordered.length) return out
  const starts = ordered.map((s) => ({ number: s.number, at: ms(s.startedAt) })).filter((s) => !Number.isNaN(s.at))
  let current = ordered[0]!.number
  let groupStep: number | null = null
  for (const line of lines) {
    const marker = classify(line.line)
    if (marker.kind === 'close' && groupStep !== null) {
      out.get(groupStep)!.push(line)
      groupStep = null
      continue
    }
    const at = ms(line.at)
    if (!Number.isNaN(at)) {
      let pick = starts.length ? starts[0]!.number : current
      for (const s of starts) {
        if (s.at <= at) pick = s.number
        else break
      }
      current = pick
    }
    out.get(current)!.push(line)
    if (marker.kind === 'open') groupStep = current
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

/** The whole steps view: steps in order, each with its refined lines, folded groups, count and default open state. */
export const stepBlocks = (job: Job, lines: LogLine[]): StepBlock[] => {
  const pseudo = job.steps.length === 0
  const steps = pseudo ? [pseudoStep(job)] : [...job.steps].sort((a, b) => a.number - b.number)
  const refined = refineLines(lines)
  const byStep = assignLines(steps, refined)
  return steps.map((step) => {
    const own = byStep.get(step.number) ?? []
    const blocks = groupLines(own)
    const count = own.filter((l) => classify(l.line).kind === 'line').length
    return { step, pseudo, lines: own, blocks, count, open: stepOpen(step) }
  })
}

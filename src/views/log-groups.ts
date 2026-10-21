import type { LogLine } from '../lib/types'

/*
 * Group markers in a job log. The runner (and GitHub's stored log) wraps blocks in `##[group]<title>` …
 * `##[endgroup]`; some tooling writes `##[section]Starting: <step>` … `##[section]Finishing: <step>`. Both are
 * one level: a new group closes the one before it, an unterminated one runs to the end. `##[error]`,
 * `##[warning]`, `##[notice]` and `##[debug]` lines carry a tone (danger, warning, notice, debug); a group takes
 * the tone of its worst error or warning and opens by default when it holds an error. `public/app.js` keeps the same rules
 * for lines that arrive over the stream: change one, change the other.
 */

export type LineTone = 'danger' | 'warning' | 'notice' | 'debug'
/** `n` is the line's number inside its step (steps view only); marker lines have none. */
export type GroupedLine = { line: LogLine; tone?: LineTone; marker?: boolean; n?: number }
/** `n` is the number of the group's header line (its `##[group]` marker) inside its step. */
export type LogGroup = { kind: 'group'; title: string; lines: GroupedLine[]; closed: boolean; tone?: 'danger' | 'warning'; n?: number }
export type LogBlock = ({ kind: 'line' } & GroupedLine) | LogGroup

export type Marker = { kind: 'open'; title: string } | { kind: 'close' } | { kind: 'line'; tone?: LineTone }

/** Terminal colour sequences carry nothing for the reader; GitHub strips them in its viewer too. */
export const plainText = (line: string) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

const OPEN_RE = /^##\[(?:group\]|section\]Starting: )(.*)$/
const CLOSE_RE = /^##\[(?:endgroup\]|section\]Finishing: )/
const TONE_RE = /^##\[(error|warning|notice|debug)\]/
const TONES: Record<string, LineTone> = { error: 'danger', warning: 'warning', notice: 'notice', debug: 'debug' }

export const classify = (raw: string): Marker => {
  const text = plainText(raw)
  const open = OPEN_RE.exec(text)
  if (open) return { kind: 'open', title: open[1]!.trim() || 'group' }
  if (CLOSE_RE.test(text)) return { kind: 'close' }
  const tone = TONE_RE.exec(text)
  if (tone) return { kind: 'line', tone: TONES[tone[1]!] }
  return { kind: 'line' }
}

/** Lines → flat lines and groups, in order. */
export const groupLines = (lines: LogLine[]): LogBlock[] => {
  const out: LogBlock[] = []
  let open: LogGroup | null = null
  const close = () => {
    if (open) open.closed = true
    open = null
  }
  for (const line of lines) {
    const m = classify(line.line)
    if (m.kind === 'open') {
      close()
      open = { kind: 'group', title: m.title, lines: [{ line, marker: true }], closed: false }
      out.push(open)
    } else if (m.kind === 'close') {
      if (open) {
        open.lines.push({ line, marker: true })
        close()
      } else out.push({ kind: 'line', line, marker: true })
    } else if (open) {
      open.lines.push({ line, tone: m.tone })
      if (m.tone === 'danger' || (m.tone === 'warning' && !open.tone)) open.tone = m.tone
    } else out.push({ kind: 'line', line, tone: m.tone })
  }
  return out
}

/** Content lines of a group: the markers are not counted. */
export const groupCount = (g: LogGroup) => g.lines.filter((l) => !l.marker).length

/** Milliseconds between the first and the last line of a group (markers included). */
export const groupDurationMs = (g: LogGroup) => {
  const first = g.lines[0]
  const last = g.lines[g.lines.length - 1]
  if (!first || !last) return 0
  const a = Date.parse(first.line.at)
  const b = Date.parse(last.line.at)
  return Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.max(0, b - a)
}

/** `0 s`, `12 s`, `3 min 4 s`, `1 h 2 min`: the same shape the job facts use. */
export const formatDuration = (ms: number) => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}

/** A group opens by default while it is still receiving lines, or when it holds an error. */
export const groupOpen = (g: LogGroup) => !g.closed || g.tone === 'danger'

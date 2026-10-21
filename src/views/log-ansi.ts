/*
 * ANSI SGR colours in job logs, the subset GitHub's viewer renders: the 16 colours (foreground and background),
 * bold, italic, underline and their resets. Each run of text with the same attributes becomes one segment with a
 * class list (`ansi-fg-1 ansi-bold`, …) that `public/app.css` maps to tailor tokens; every other escape sequence
 * (cursor moves, 256-colour and true colour, unknown codes) is dropped. The text itself is never HTML: callers
 * escape it. Pure; `public/app.js` keeps the same rules for streamed lines: change one, change the other.
 */

export type AnsiSegment = { text: string; cls: string }

type State = { fg: number | null; bg: number | null; bold: boolean; italic: boolean; underline: boolean }

const PLAIN: State = { fg: null, bg: null, bold: false, italic: false, underline: false }

const classOf = (s: State): string =>
  [s.fg !== null ? `ansi-fg-${s.fg}` : '', s.bg !== null ? `ansi-bg-${s.bg}` : '', s.bold ? 'ansi-bold' : '', s.italic ? 'ansi-italic' : '', s.underline ? 'ansi-underline' : ''].filter(Boolean).join(' ')

/** Applies one SGR parameter list (`1;36`, `0`, ``) to `s`; unknown codes change nothing. */
export function applySgr(s: State, params: string): State {
  const next = { ...s }
  const codes = params === '' ? [0] : params.split(';').map((p) => (p === '' ? 0 : Number(p)))
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!
    if (c === 0) Object.assign(next, PLAIN)
    else if (c === 1) next.bold = true
    else if (c === 3) next.italic = true
    else if (c === 4) next.underline = true
    else if (c === 22) next.bold = false
    else if (c === 23) next.italic = false
    else if (c === 24) next.underline = false
    else if (c >= 30 && c <= 37) next.fg = c - 30
    else if (c >= 90 && c <= 97) next.fg = c - 90 + 8
    else if (c === 39) next.fg = null
    else if (c >= 40 && c <= 47) next.bg = c - 40
    else if (c >= 100 && c <= 107) next.bg = c - 100 + 8
    else if (c === 49) next.bg = null
    else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0 // 256 / true colour: skipped
  }
  return next
}

// eslint-disable-next-line no-control-regex
const ESCAPE_RE = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b|[\x00-\x08\x0b-\x1f\x7f]/g

/** `raw` → segments of plain text with the classes of the attributes in force; no escape character survives. */
export function ansiSegments(raw: string): AnsiSegment[] {
  const out: AnsiSegment[] = []
  let state = PLAIN
  let last = 0
  const push = (text: string) => {
    if (!text) return
    const cls = classOf(state)
    const prev = out[out.length - 1]
    if (prev && prev.cls === cls) prev.text += text
    else out.push({ text, cls })
  }
  for (const m of raw.matchAll(ESCAPE_RE)) {
    push(raw.slice(last, m.index))
    last = m.index + m[0].length
    if (m[2] === 'm' && !m[1]!.includes('?')) state = applySgr(state, m[1]!)
  }
  push(raw.slice(last))
  return out
}

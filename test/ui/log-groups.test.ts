import { describe, expect, test } from 'bun:test'
import { classify, formatDuration, groupCount, groupDurationMs, groupLines, groupOpen, type LogGroup } from '../../src/views/log-groups'

const at = (s: number) => `2026-10-20T10:00:${String(s).padStart(2, '0')}.000Z`
const lines = (...text: string[]) => text.map((line, i) => ({ seq: i + 1, at: at(i), line }))

describe('classify', () => {
  test('markers, tones, ansi stripped first', () => {
    expect(classify('##[group]Run tests')).toEqual({ kind: 'open', title: 'Run tests' })
    expect(classify('\x1b[36;1m##[group]Colour\x1b[0m')).toEqual({ kind: 'open', title: 'Colour' })
    expect(classify('##[group]')).toEqual({ kind: 'open', title: 'group' })
    expect(classify('##[section]Starting: Checkout')).toEqual({ kind: 'open', title: 'Checkout' })
    expect(classify('##[endgroup]')).toEqual({ kind: 'close' })
    expect(classify('##[section]Finishing: Checkout')).toEqual({ kind: 'close' })
    expect(classify('##[error]Process completed with exit code 1.')).toEqual({ kind: 'line', tone: 'danger' })
    expect(classify('##[warning]deprecated')).toEqual({ kind: 'line', tone: 'warning' })
    expect(classify('##[command]/usr/bin/git version')).toEqual({ kind: 'line' })
    expect(classify('  ##[group]not at the start')).toEqual({ kind: 'line' })
  })
})

describe('groupLines', () => {
  test('flat lines stay flat; a group folds its lines with the markers hidden', () => {
    const out = groupLines(lines('a', '##[group]G', 'one', 'two', '##[endgroup]', 'z'))
    expect(out.map((b) => b.kind)).toEqual(['line', 'group', 'line'])
    const g = out[1] as LogGroup
    expect(g.title).toBe('G')
    expect(g.closed).toBe(true)
    expect(g.lines.map((l) => [l.line.line, l.marker ?? false])).toEqual([
      ['##[group]G', true],
      ['one', false],
      ['two', false],
      ['##[endgroup]', true],
    ])
    expect(groupCount(g)).toBe(2)
    expect(groupDurationMs(g)).toBe(3000)
    expect(groupOpen(g)).toBe(false)
  })

  test('a nested group start closes the one before it (one level only)', () => {
    const out = groupLines(lines('##[group]outer', 'a', '##[group]inner', 'b', '##[endgroup]', 'c'))
    expect(out.map((b) => b.kind)).toEqual(['group', 'group', 'line'])
    const [outer, inner] = out as LogGroup[]
    expect(outer!.closed).toBe(true)
    expect(groupCount(outer!)).toBe(1)
    expect(inner!.title).toBe('inner')
    expect(inner!.closed).toBe(true)
    expect(groupCount(inner!)).toBe(1)
  })

  test('an unterminated group runs to the end and stays open', () => {
    const out = groupLines(lines('##[group]tail', 'a', 'b'))
    const g = out[0] as LogGroup
    expect(out.length).toBe(1)
    expect(g.closed).toBe(false)
    expect(groupCount(g)).toBe(2)
    expect(groupOpen(g)).toBe(true)
  })

  test('an orphan endgroup is a hidden flat marker', () => {
    const out = groupLines(lines('a', '##[endgroup]', 'b'))
    expect(out.map((b) => (b.kind === 'line' ? b.marker ?? false : 'group'))).toEqual([false, true, false])
  })

  test('error and warning tones; an error opens its group, a warning does not', () => {
    const out = groupLines(lines('##[warning]w', '##[group]A', '##[warning]x', '##[endgroup]', '##[group]B', 'ok', '##[error]boom', '##[endgroup]'))
    expect(out[0]).toMatchObject({ kind: 'line', tone: 'warning' })
    const a = out[1] as LogGroup
    const b = out[2] as LogGroup
    expect(a.tone).toBe('warning')
    expect(groupOpen(a)).toBe(false)
    expect(b.tone).toBe('danger')
    expect(groupOpen(b)).toBe(true)
    expect(b.lines[2]).toMatchObject({ tone: 'danger' })
  })

  test('section markers behave like groups', () => {
    const out = groupLines(lines('##[section]Starting: Build', 'x', '##[section]Finishing: Build', 'y'))
    expect(out.map((b) => b.kind)).toEqual(['group', 'line'])
    expect((out[0] as LogGroup).title).toBe('Build')
  })

  test('empty input', () => {
    expect(groupLines([])).toEqual([])
  })
})

describe('formatDuration', () => {
  test('seconds, minutes, hours', () => {
    expect(formatDuration(0)).toBe('0 s')
    expect(formatDuration(12_400)).toBe('12 s')
    expect(formatDuration(184_000)).toBe('3 min 4 s')
    expect(formatDuration(3_720_000)).toBe('1 h 2 min')
  })
})

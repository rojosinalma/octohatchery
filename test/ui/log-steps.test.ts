import { describe, expect, test } from 'bun:test'
import type { Job, JobStep } from '../../src/lib/types'
import { assignLines, commandText, elapsed, isProgress, outcomeVerb, pseudoStep, refineLines, shortDuration, stepBlocks, stepDurationMs, stepIcon, stepOpen } from '../../src/views/log-steps'

const at = (s: string) => `2026-10-20T10:${s}Z`
const line = (seq: number, stamp: string, text = `line ${seq}`) => ({ seq, at: at(stamp), line: text })
const step = (number: number, name: string, startedAt: string | null, completedAt: string | null, conclusion: JobStep['conclusion'] = 'success', status = 'completed'): JobStep => ({
  number,
  name,
  status,
  conclusion,
  startedAt: startedAt && at(startedAt),
  completedAt: completedAt && at(completedAt),
})
const steps = [step(1, 'Set up job', '00:00', '00:10'), step(2, 'Build', '00:10', '02:00', 'failure'), step(3, 'Complete job', '02:00', '02:05')]

describe('assignLines', () => {
  test('a line goes to the last step started at or before its stamp (ms precision, 7-digit fractions)', () => {
    const out = assignLines(steps, [line(1, '00:05'), line(2, '00:10.0000000'), line(3, '00:09.9999999'), line(4, '01:59.5'), line(5, '02:00')])
    expect([...out.entries()].map(([n, ls]) => [n, ls.map((l) => l.seq)])).toEqual([
      [1, [1, 3]],
      [2, [2, 4]],
      [3, [5]],
    ])
  })

  test('lines before the first step go to the first step, lines after the last step to the last step', () => {
    const out = assignLines(steps, [line(1, '00:00.000') /* equal */, line(2, '09:00'), { seq: 3, at: '2026-10-20T09:59:59Z', line: 'early' }])
    expect(out.get(1)!.map((l) => l.seq)).toEqual([1, 3])
    expect(out.get(3)!.map((l) => l.seq)).toEqual([2])
  })

  test('a line without a readable stamp follows the line before it; steps are returned in number order', () => {
    const out = assignLines([steps[1]!, steps[0]!], [line(1, '00:30'), { seq: 2, at: 'n/a', line: 'cont' }, { seq: 3, at: '', line: 'x' }])
    expect([...out.keys()]).toEqual([1, 2])
    expect(out.get(2)!.map((l) => l.seq)).toEqual([1, 2, 3])
  })

  test('an endgroup stamped in the next step stays with the step that opened the group', () => {
    const out = assignLines(steps, [line(1, '00:08', '##[group]Starting service'), line(2, '00:09', 'up'), line(3, '00:10.5', '##[endgroup]'), line(4, '00:11', 'first of build'), line(5, '00:12', '##[endgroup]')])
    expect(out.get(1)!.map((l) => l.seq)).toEqual([1, 2, 3])
    expect(out.get(2)!.map((l) => l.seq)).toEqual([4, 5])
  })

  test('steps not started yet are not candidates; no steps → empty map', () => {
    const out = assignLines([step(1, 'a', '00:00', '00:10'), step(2, 'b', null, null, null, 'queued')], [line(1, '05:00')])
    expect(out.get(1)!.map((l) => l.seq)).toEqual([1])
    expect(out.get(2)).toEqual([])
    expect(assignLines([], [line(1, '00:00')]).size).toBe(0)
  })
})

describe('refineLines', () => {
  test('blank (and whitespace-only, ansi-only) lines are dropped', () => {
    const out = refineLines([line(1, '00:00', 'a'), line(2, '00:01', ''), line(3, '00:02', '   '), line(4, '00:03', '\x1b[0m'), line(5, '00:04', 'b')])
    expect(out.map((l) => l.seq)).toEqual([1, 5])
  })

  test('a run of consecutive progress lines keeps only its last one; separate runs stay separate', () => {
    const out = refineLines([
      line(1, '00:00', 'Downloading'),
      line(2, '00:01', 'Received 0 of 42016230 (0.0%), 0.0 MBs/sec'),
      line(3, '00:02', 'Received 29433318 of 42016230 (70.1%), 14.0 MBs/sec'),
      line(4, '00:03', 'Received 42016230 of 42016230 (100.0%), 12.2 MBs/sec'),
      line(5, '00:04', 'Extracting'),
      line(6, '00:05', '10% done'),
      line(7, '00:06', '100% done'),
      line(8, '00:07', 'ok'),
    ])
    expect(out.map((l) => l.seq)).toEqual([1, 4, 5, 7, 8])
  })

  test('isProgress matches GitHub transfer lines and percentages at the start, not prose with a number', () => {
    expect(isProgress('Received 0 of 10 (0.0%), 0.0 MBs/sec')).toBe(true)
    expect(isProgress('45.5% ')).toBe(true)
    expect(isProgress('  layer abc: 30% (3/10)')).toBe(true)
    expect(isProgress('Coverage is 100% green')).toBe(false)
    expect(isProgress('Received a message')).toBe(false)
  })
})

describe('commandText', () => {
  test('strips the ##[command] / [command] marker, nothing else', () => {
    expect(commandText('##[command]/usr/bin/git version')).toBe('/usr/bin/git version')
    expect(commandText('[command]/usr/bin/docker ps')).toBe('/usr/bin/docker ps')
    expect(commandText('\x1b[36;1m##[command]echo hi\x1b[0m')).toBe('echo hi')
    expect(commandText('##[group]x')).toBeNull()
    expect(commandText('  ##[command]not at start')).toBeNull()
  })
})

describe('step state', () => {
  test('icon and tone per status/conclusion', () => {
    expect(stepIcon(step(1, 'a', '00:00', '00:01', 'success'))).toEqual({ icon: 'bi-check-circle-fill', tone: 'success', label: 'succeeded' })
    expect(stepIcon(step(1, 'a', '00:00', '00:01', 'failure'))).toEqual({ icon: 'bi-x-circle-fill', tone: 'danger', label: 'failed' })
    expect(stepIcon(step(1, 'a', '00:00', '00:01', 'cancelled'))).toMatchObject({ icon: 'bi-slash-circle', tone: 'muted' })
    expect(stepIcon(step(1, 'a', '00:00', '00:01', 'skipped'))).toMatchObject({ icon: 'bi-slash-circle', tone: 'muted' })
    expect(stepIcon(step(1, 'a', '00:00', null, null, 'in_progress'))).toMatchObject({ icon: 'spinner' })
    expect(stepIcon(step(1, 'a', null, null, null, 'queued'))).toMatchObject({ icon: 'bi-dash-circle', tone: 'muted' })
  })

  test('failed and running steps open; everything else is collapsed', () => {
    expect(stepOpen(steps[0]!)).toBe(false)
    expect(stepOpen(steps[1]!)).toBe(true)
    expect(stepOpen(step(1, 'a', '00:00', null, null, 'in_progress'))).toBe(true)
    expect(stepOpen(step(1, 'a', null, null, null, 'queued'))).toBe(false)
  })

  test('durations: completed span, running counts to now, unknown start is 0; short format', () => {
    expect(stepDurationMs(steps[1]!)).toBe(110_000)
    expect(stepDurationMs(step(1, 'a', '00:00', null), Date.parse(at('00:30')))).toBe(30_000)
    expect(stepDurationMs(step(1, 'a', null, null))).toBe(0)
    expect(shortDuration(0)).toBe('0s')
    expect(shortDuration(140_000)).toBe('2m 20s')
    expect(shortDuration(3_720_000)).toBe('1h 2m')
  })

  test('elapsed is mm:ss since the base, h:mm:ss past an hour, 00:00 before it or without a base', () => {
    expect(elapsed(at('00:05.1234567'), at('00:00'))).toBe('00:05')
    expect(elapsed(at('02:20'), at('00:00'))).toBe('02:20')
    expect(elapsed('2026-10-20T11:02:03Z', at('00:00'))).toBe('1:02:03')
    expect(elapsed(at('00:00'), at('00:10'))).toBe('00:00')
    expect(elapsed(at('00:10'), null)).toBe('00:00')
  })

  test('outcome verb', () => {
    expect(outcomeVerb({ status: 'completed', conclusion: 'success' })).toBe('succeeded')
    expect(outcomeVerb({ status: 'completed', conclusion: 'failure' })).toBe('failed')
    expect(outcomeVerb({ status: 'completed', conclusion: 'timed_out' })).toBe('timed out')
    expect(outcomeVerb({ status: 'completed', conclusion: null })).toBe('finished')
    expect(outcomeVerb({ status: 'in_progress', conclusion: null })).toBe('running')
    expect(outcomeVerb({ status: 'queued', conclusion: null })).toBe('queued')
  })
})

describe('stepBlocks', () => {
  const job = (overrides: Partial<Job> = {}): Job => ({
    id: 1,
    repo: 'a/b',
    githubJobId: 1,
    runId: 1,
    name: 'j',
    labels: [],
    status: 'completed',
    conclusion: 'failure',
    runnerId: null,
    htmlUrl: '',
    queuedAt: at('00:00'),
    startedAt: at('00:00'),
    completedAt: at('02:05'),
    logSource: 'github',
    logBytes: 0,
    logTruncated: false,
    steps,
    ...overrides,
  })

  test('lines refined, then placed; groups fold inside a step; counts skip markers', () => {
    const out = stepBlocks(job(), [line(1, '00:01', 'a'), line(2, '00:02', ''), line(3, '00:20', '##[group]G'), line(4, '00:21', 'in'), line(5, '00:22', '##[endgroup]'), line(6, '02:01', 'end')])
    expect(out.map((b) => [b.step.number, b.count, b.open, b.blocks.map((x) => x.kind)])).toEqual([
      [1, 1, false, ['line']],
      [2, 1, true, ['group']],
      [3, 1, false, ['line']],
    ])
    expect(out.every((b) => !b.pseudo)).toBe(true)
  })

  test('a job without steps gets one pseudo-step "Log" with the job state and every line', () => {
    const out = stepBlocks(job({ steps: [], status: 'in_progress', conclusion: null, completedAt: null }), [line(1, '00:01'), line(2, '05:00')])
    expect(out).toHaveLength(1)
    expect(out[0]!.pseudo).toBe(true)
    expect(out[0]!.step).toEqual({ number: 0, name: 'Log', status: 'in_progress', conclusion: null, startedAt: at('00:00'), completedAt: null })
    expect(out[0]!.count).toBe(2)
    expect(out[0]!.open).toBe(true)
    expect(pseudoStep({ status: 'queued', conclusion: null, startedAt: null, completedAt: null })).toMatchObject({ status: 'queued', conclusion: null })
  })
})

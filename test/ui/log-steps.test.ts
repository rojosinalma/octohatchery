import { describe, expect, test } from 'bun:test'
import type { Job, JobStep } from '../../src/lib/types'
import { annotationTarget, assignLines, stepOpener, commandText, elapsed, isProgress, lineAnchor, lineView, numberBlocks, outcomeVerb, pseudoStep, refineLines, shortDuration, stepBlocks, stepDurationMs, stepIcon, stepOpen } from '../../src/views/log-steps'
import { classify, groupLines } from '../../src/views/log-groups'

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
  test('a stamp a whole second past a step start moves to that step; inside the start second the current step keeps its lines', () => {
    const out = assignLines(steps, [line(1, '00:05'), line(2, '00:10.0000000'), line(3, '00:10.9999999'), line(4, '00:11.0000000'), line(5, '01:59.5'), line(6, '02:00')])
    expect([...out.entries()].map(([n, ls]) => [n, ls.map((l) => l.seq)])).toEqual([
      [1, [1, 2, 3]],
      [2, [4, 5, 6]],
      [3, []],
    ])
  })

  test('a step opener inside the start second moves on: to the step it names, else to the next started one', () => {
    const three = [step(1, 'Set up job', '00:00', '00:01'), step(2, 'Run actions/checkout@v7', '00:01', '00:02'), step(3, 'Standard', '00:02', '00:05', 'failure'), step(8, 'Post Run actions/checkout@v7', '00:05', '00:05'), step(9, 'Complete job', '00:05', '00:05')]
    const out = assignLines(three, [
      line(1, '00:00.5', 'Current runner version'),
      line(2, '00:01.4', 'Complete job name: lint'), // still set-up output, in checkout's start second
      line(3, '00:01.5', '##[group]Run actions/checkout@v7'),
      line(4, '00:02.2', 'Syncing repository'), // checkout's tail in Standard's start second
      line(5, '00:02.3', '##[group]Run bundle exec standardrb'),
      line(6, '00:05.3', 'lib/a.rb:45:7: Style/GlobalVars'), // printed in the second Post and Complete start
      line(7, '00:05.38', '##[error]Process completed with exit code 1.'),
      line(8, '00:05.43', 'Post job cleanup.'),
      line(9, '00:05.60', '[command]/usr/bin/git version'),
      line(10, '00:05.64', 'Cleaning up orphan processes'),
    ])
    expect([...out.entries()].map(([n, ls]) => [n, ls.map((l) => l.seq)])).toEqual([
      [1, [1, 2]],
      [2, [3, 4]],
      [3, [5, 6, 7]],
      [8, [8, 9]],
      [9, [10]],
    ])
    expect(stepOpener('##[group]Run ruby/setup-ruby@v1')).toBe('Run ruby/setup-ruby@v1')
    expect(stepOpener('Post job cleanup.')).toBe('')
    expect(stepOpener('##[group]Run tests')).toBe('Run tests')
    expect(stepOpener('##[group]Checking docker version')).toBeNull()
    expect(stepOpener('Running tests')).toBeNull()
  })

  test('an opener names a later started step: the steps between printed nothing; skipped steps take no lines', () => {
    const s = [step(1, 'Set up job', '00:00', '00:01'), step(2, 'Lint', '00:01', '00:01', 'skipped'), step(3, 'Run actions/cache@v4', '00:01', '00:03'), step(4, 'Run actions/checkout@v7', '00:01', '00:02')]
    const out = assignLines(s, [line(1, '00:00.5', 'setup'), line(2, '00:01.2', '##[group]Run actions/checkout@v7'), line(3, '00:05', 'later')])
    expect(out.get(2)).toEqual([])
    expect(out.get(4)!.map((l) => l.seq)).toEqual([2, 3])
  })

  test('lines before the first step go to the first step, lines after the last step to the last step; never back to an earlier step', () => {
    const out = assignLines(steps, [line(1, '00:00.000') /* equal */, { seq: 2, at: '2026-10-20T09:59:59Z', line: 'early' }, line(3, '09:00'), { seq: 4, at: '2026-10-20T09:59:59Z', line: 'out of order' }])
    expect(out.get(1)!.map((l) => l.seq)).toEqual([1, 2])
    expect(out.get(3)!.map((l) => l.seq)).toEqual([3, 4])
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

describe('assignLines with step numbers', () => {
  test('a line that carries its step goes there whatever its stamp; lines without one use the timestamp split', () => {
    const out = assignLines(steps, [
      { ...line(1, '01:30', 'printed late, but by step 1'), step: 1 },
      { ...line(2, '02:01', 'standardrb output'), step: 2 },
      { ...line(3, '02:01', '##[endgroup]'), step: 2 },
      line(4, '00:05', 'live, step-less'),
      { ...line(5, '02:03', 'unknown step number'), step: 7 },
    ])
    expect([...out.entries()].map(([n, ls]) => [n, ls.map((l) => l.seq)])).toEqual([
      [1, [1]],
      [2, [2, 3, 4]], // a step-less line after step 2's lines stays there: lines never go back
      [3, [5]],
    ])
  })

  test('null step (the flat log, live lines) is the timestamp split unchanged', () => {
    const plain = [line(1, '00:05'), line(2, '01:00'), line(3, '02:01')]
    const seqs = (m: Map<number, { seq: number }[]>) => [...m.entries()].map(([n, ls]) => [n, ls.map((l) => l.seq)])
    expect(seqs(assignLines(steps, plain.map((l) => ({ ...l, step: null }))))).toEqual(seqs(assignLines(steps, plain)))
  })
})

describe('markers and numbers', () => {
  test('lineView strips the shown markers (also behind colour codes) and keeps the colours', () => {
    expect(lineView('##[error]Process completed with exit code 1.')).toEqual({ kind: 'danger', raw: 'Process completed with exit code 1.' })
    expect(lineView('##[warning]slow')).toEqual({ kind: 'warning', raw: 'slow' })
    expect(lineView('##[notice]fyi')).toEqual({ kind: 'notice', raw: 'fyi' })
    expect(lineView('##[debug]Evaluating: success()')).toEqual({ kind: 'debug', raw: 'Evaluating: success()' })
    expect(lineView('[command]/usr/bin/git version')).toEqual({ kind: 'cmd', raw: '/usr/bin/git version' })
    expect(lineView('\x1b[36;1m##[command]echo hi\x1b[0m')).toEqual({ kind: 'cmd', raw: '\x1b[36;1mecho hi\x1b[0m' })
    expect(lineView('text ##[error] later')).toEqual({ kind: 'text', raw: 'text ##[error] later' })
    expect(classify('##[notice]x')).toEqual({ kind: 'line', tone: 'notice' })
    expect(classify('##[debug]x')).toEqual({ kind: 'line', tone: 'debug' })
  })

  test('numbers start at 1 per step: a group header counts, its markers do not; the next number is returned', () => {
    const blocks = groupLines([line(1, '00:00', 'a'), line(2, '00:01', '##[group]G'), line(3, '00:02', 'in'), line(4, '00:03', '##[endgroup]'), line(5, '00:04', '##[endgroup]'), line(6, '00:05', 'b')])
    expect(numberBlocks(blocks)).toBe(5)
    const flat = blocks.flatMap((b) => (b.kind === 'group' ? [{ n: b.n, what: `group ${b.title}` }, ...b.lines.map((l) => ({ n: l.n, what: l.line.line }))] : [{ n: b.n, what: b.line.line }]))
    expect(flat).toEqual([
      { n: 1, what: 'a' },
      { n: 2, what: 'group G' },
      { n: undefined, what: '##[group]G' },
      { n: 3, what: 'in' },
      { n: undefined, what: '##[endgroup]' },
      { n: undefined, what: '##[endgroup]' },
      { n: 4, what: 'b' },
    ])
    expect(lineAnchor(4, 12)).toBe('step-4-12')
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
    annotations: [],
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

  test('error and warning counts per step; an annotation links to the first matching line of its level', () => {
    const out = stepBlocks(job(), [
      { ...line(1, '00:20', '##[warning]deprecated'), step: 2 },
      { ...line(2, '00:21', '##[error]Process completed with exit code 1.'), step: 2 },
      { ...line(3, '00:22', '##[error]second'), step: 2 },
      { ...line(4, '02:01', 'done'), step: 3 },
    ])
    expect(out.map((b) => [b.step.number, b.errors, b.warnings, b.next])).toEqual([
      [1, 0, 0, 1],
      [2, 2, 1, 4],
      [3, 0, 0, 2],
    ])
    expect(annotationTarget(out, { level: 'failure', message: 'Process completed with exit code 1.' })).toBe('step-2-2')
    expect(annotationTarget(out, { level: 'warning', message: 'deprecated\nmore detail' })).toBe('step-2-1')
    expect(annotationTarget(out, { level: 'notice', message: 'deprecated' })).toBeNull()
    expect(annotationTarget(out, { level: 'failure', message: '  ' })).toBeNull()
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

import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { fresh, TEST_HOST } from './helpers'
import { backfillSteps, configureJobLog, ensureFollower, finalise, isFollowing, parseGitHubLog, settled, TRUNCATED_NOTICE } from '../../src/lib/joblog'
import { stepBlocks } from '../../src/views/log-steps'
import { job87Details, job87Flat } from './job87'
import { parseTimestampedLine } from '../../src/lib/backends/docker'
import { claim, reap, tick } from '../../src/lib/scheduler'
import { service } from '../../src/lib/service'
import { purgeRetention } from '../../src/lib/sweep'
import { insertJobIfNew, jobById, runnerById, updateJob } from '../../src/lib/store'
import { bus, type LogEvent } from '../../src/lib/bus'
import { ServiceError } from '../../src/lib/types'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Adopt, give this host one generic slot, queue one job and claim it: returns the runner and its feed. */
async function spawnOne(w: Awaited<ReturnType<typeof fresh>>, githubJobId = 1) {
  await service.adoptRepo('acme/app', 'user')
  await service.setSlots({ host: TEST_HOST, type: 'generic', count: 1 }, 'user')
  await insertJobIfNew({ repo: 'acme/app', githubJobId, runId: 1, name: 'build', labels: ['self-hosted', 'generic'], htmlUrl: '', queuedAt: '2026-01-01T00:00:00Z', status: 'queued' })
  const [runner] = await claim()
  expect(runner).toBeDefined()
  const feed = w.docker.feed(runner!.containerId!)
  return { runner: runner!, feed, jobId: runner!.jobId! }
}

/** Polls until `fn` is truthy (the follower writes asynchronously). */
async function until<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 2000): Promise<T> {
  const start = Date.now()
  let v = await fn()
  while (!pred(v) && Date.now() - start < ms) {
    await wait(20)
    v = await fn()
  }
  return v
}

describe('job log follower', () => {
  test('spawning a job starts a follower; batches land in job_logs in order and are announced on the bus', async () => {
    const w = await fresh()
    const { runner, feed, jobId } = await spawnOne(w)
    expect(w.docker.spawns[0]!.env.ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT).toBe('1')
    expect(isFollowing(runner.id)).toBe(true)
    const batches: LogEvent[] = []
    const onLog = (ev: LogEvent) => batches.push(ev)
    bus.on('log', onLog)

    for (let i = 1; i <= 70; i++) feed.push(`line ${i}`, `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000000000Z`)
    const log = await until(() => service.getJobLog(jobId), (l) => l.lines.length === 70)
    expect(log.lines.map((l) => l.seq)).toEqual(Array.from({ length: 70 }, (_, i) => i + 1))
    expect(log.lines[0]).toEqual({ seq: 1, at: '2026-01-01T00:00:01.000000000Z', line: 'line 1' })
    expect(log.source).toBeNull()
    expect(log.complete).toBe(false)
    // 64 lines flushed at once, the rest on the timer
    expect(batches.map((b) => b.lines.length)).toEqual([64, 6])
    expect(batches.every((b) => b.jobId === jobId)).toBe(true)
    bus.off('log', onLog)

    // paging with `after`
    const page = await service.getJobLog(jobId, { after: 68 })
    expect(page.lines.map((l) => l.line)).toEqual(['line 69', 'line 70'])
    expect((await service.getJobLog(jobId, { after: 10, limit: 3 })).lines.map((l) => l.seq)).toEqual([11, 12, 13])
    expect((await service.getJobLog(jobId, { tail: 2 })).lines.map((l) => l.seq)).toEqual([69, 70])
    expect((await service.getJob(jobId)).logBytes).toBeGreaterThan(0)
  })

  test('container exit without a GitHub log keeps the runner lines and marks source runner', async () => {
    const w = await fresh()
    const { runner, feed, jobId } = await spawnOne(w)
    feed.push('hello')
    feed.push('world')
    w.docker.exit(runner.containerId!)
    await wait(30)
    await settled()
    const log = await service.getJobLog(jobId)
    expect(log.lines.map((l) => l.line)).toEqual(['hello', 'world'])
    expect(log.source).toBe('runner')
    expect(log.complete).toBe(true)
    expect(isFollowing(runner.id)).toBe(false)
    expect(w.github.calls.filter((c) => c.method === 'getJobLog')).toHaveLength(1)
  })

  test("GitHub's log replaces the live lines once available (404 first, retried)", async () => {
    const w = await fresh()
    configureJobLog({ retryDelaysMs: [20, 20, 20], flushMs: 10 })
    const { runner, feed, jobId } = await spawnOne(w, 42)
    feed.push('live 1')
    feed.push('live 2')
    const done: LogEvent[] = []
    const onLog = (ev: LogEvent) => ev.done && done.push(ev)
    bus.on('log', onLog)
    w.docker.exit(runner.containerId!)
    await wait(30) // first attempt: 404
    w.github.jobLogs.set('acme/app#42', '2026-01-01T00:00:01.1234567Z Set up job\n2026-01-01T00:00:02.0000000Z ##[group]Run tests\ncontinued without stamp\n2026-01-01T00:00:03.0000000Z Done\n\n')
    await settled()
    bus.off('log', onLog)
    const log = await service.getJobLog(jobId)
    expect(log.source).toBe('github')
    expect(log.complete).toBe(true)
    expect(log.lines.map((l) => [l.seq, l.at, l.line])).toEqual([
      [1, '2026-01-01T00:00:01.1234567Z', 'Set up job'],
      [2, '2026-01-01T00:00:02.0000000Z', '##[group]Run tests'],
      [3, '2026-01-01T00:00:02.0000000Z', 'continued without stamp'],
      [4, '2026-01-01T00:00:03.0000000Z', 'Done'],
    ])
    expect(done).toEqual([{ jobId, lines: [], done: true, replaced: true }])
    expect(w.github.calls.filter((c) => c.method === 'getJobLog').length).toBeGreaterThanOrEqual(2)
    // the finaliser asked GitHub for the job once and stored its steps (authoritative timestamps)
    expect(w.github.calls.filter((c) => c.method === 'getJob')).toEqual([{ method: 'getJob', args: ['acme/app', 42] }])
    expect((await service.getJob(jobId)).steps.map((s) => s.name)).toEqual(['Set up job', 'Run tests'])
  })

  test('a failed steps fetch is not fatal: the log is still finalised with empty steps', async () => {
    const w = await fresh()
    configureJobLog({ retryDelaysMs: [20], flushMs: 10 })
    w.github.failOn.set('getJob', 'Resource not accessible by integration')
    const { runner, feed, jobId } = await spawnOne(w, 43)
    feed.push('live')
    w.github.jobLogs.set('acme/app#43', '2026-01-01T00:00:01.0000000Z Done')
    w.docker.exit(runner.containerId!)
    await settled()
    const log = await service.getJobLog(jobId)
    expect(log.source).toBe('github')
    expect((await service.getJob(jobId)).steps).toEqual([])
  })

  test('backfillSteps fills completed jobs with a GitHub log and no steps, at most `max` per pass, and skips the rest', async () => {
    const w = await fresh()
    for (const [id, source, status] of [
      [1, 'github', 'completed'],
      [2, 'github', 'completed'],
      [3, 'runner', 'completed'],
      [4, null, 'in_progress'],
    ] as const) {
      await w.db.run(sql`insert into jobs (repo, github_job_id, run_id, name, labels, status, html_url, queued_at, completed_at, log_source)
        values ('acme/app', ${id}, 1, 'j', '[]', ${status}, '', '2026-01-01T00:00:00Z', ${status === 'completed' ? `2026-01-01T00:0${id}:00Z` : null}, ${source})`)
    }
    configureJobLog()
    w.github.failOn.set('getJob', 'rate limited')
    expect(await backfillSteps(1)).toBe(0) // job 2 (newest) tried and failed: not asked again by this process
    w.github.failOn.delete('getJob')
    expect(await backfillSteps(1)).toBe(1)
    expect(await backfillSteps(5)).toBe(0)
    expect(jobById(2).then((j) => j!.steps)).resolves.toEqual([])
    configureJobLog() // a new process asks again
    expect(await backfillSteps(5)).toBe(1)
    const filled = await Promise.all([1, 2, 3, 4].map((id) => jobById(id)))
    expect(filled.map((j) => j!.steps.length)).toEqual([2, 2, 0, 0])
    expect(w.github.calls.filter((c) => c.method === 'getJob')).toHaveLength(3)
  })

  test('the cap stops storage, marks the job truncated and appends one notice line', async () => {
    const w = await fresh()
    await service.setSetting('log_max_kb', '1', 'user')
    const { runner, feed, jobId } = await spawnOne(w)
    const big = 'x'.repeat(300)
    for (let i = 0; i < 10; i++) feed.push(big) // 3 KB > 1 KB cap
    const log = await until(() => service.getJobLog(jobId), (l) => l.truncated)
    expect(log.truncated).toBe(true)
    // 3 × 301 bytes fit, the 4th does not: three lines plus the notice
    expect(log.lines).toHaveLength(4)
    expect(log.lines[3]!.line).toBe(TRUNCATED_NOTICE(1))
    expect((await service.getJob(jobId)).logBytes).toBeLessThanOrEqual(1024)
    // more output is dropped while the container keeps running
    feed.push('late')
    await wait(50)
    expect((await service.getJobLog(jobId)).lines).toHaveLength(4)
    expect(isFollowing(runner.id)).toBe(true)
    // the GitHub log is capped the same way once the container exits
    w.github.jobLogs.set('acme/app#1', Array.from({ length: 10 }, (_, i) => `2026-01-01T00:00:0${i % 10}.0000000Z ${big}`).join('\n'))
    w.docker.exit(runner.containerId!)
    await settled()
    const final = await service.getJobLog(jobId)
    expect(final.source).toBe('github')
    expect(final.truncated).toBe(true)
    expect(final.lines).toHaveLength(4)
    expect(final.lines[3]!.line).toBe(TRUNCATED_NOTICE(1))
  })

  test('re-attach resumes after the last stored line and skips re-delivered ones', async () => {
    const w = await fresh()
    const { runner, feed, jobId } = await spawnOne(w)
    feed.push('a', '2026-01-01T00:00:01.000000000Z')
    feed.push('b', '2026-01-01T00:00:02.000000000Z')
    await until(() => service.getJobLog(jobId), (l) => l.lines.length === 2)
    // "restart": the old follower is gone, the reaper re-attaches on the next tick; the engine re-sends the last second
    configureJobLog({ retryDelaysMs: [], flushMs: 10 })
    const again = w.docker.replaceFeed(runner.containerId!)
    expect(isFollowing(runner.id)).toBe(false)
    await reap()
    expect(isFollowing(runner.id)).toBe(true)
    again.push('b', '2026-01-01T00:00:02.000000000Z') // duplicate within the `since` second
    again.push('c', '2026-01-01T00:00:03.000000000Z')
    const log = await until(() => service.getJobLog(jobId), (l) => l.lines.length === 3)
    expect(log.lines.map((l) => [l.seq, l.line])).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ])
  })

  test('a job that finished with its log final is not followed again', async () => {
    const w = await fresh()
    const { runner, jobId } = await spawnOne(w)
    w.docker.exit(runner.containerId!)
    await settled()
    expect((await service.getJobLog(jobId)).source).toBe('runner')
    configureJobLog({ retryDelaysMs: [], flushMs: 10 })
    ensureFollower((await runnerById(runner.id))!)
    await settled()
    expect(w.github.calls.filter((c) => c.method === 'getJobLog')).toHaveLength(1)
  })

  test('finalise is a no-op for another node: only runners of this host are followed', async () => {
    const w = await fresh()
    await w.db.run(sql`insert into hosts (name, status, last_seen_at, is_leader, docker_ok) values ('node-b', 'online', ${new Date().toISOString()}, false, true)`)
    const { runner } = await spawnOne(w)
    const other = { ...runner, id: 99, host: 'node-b', containerId: 'elsewhere' }
    ensureFollower(other)
    expect(isFollowing(99)).toBe(false)
  })

  test('complete flag: finished job without a runner, unknown job 404', async () => {
    await fresh()
    const job = await insertJobIfNew({ repo: 'acme/app', githubJobId: 5, runId: 1, name: 'x', labels: ['ubuntu-latest'], htmlUrl: '', queuedAt: '2026-01-01T00:00:00Z', status: 'ignored' })
    const log = await service.getJobLog(job!.id)
    expect(log).toEqual({ lines: [], source: null, truncated: false, complete: true })
    await updateJob(job!.id, { status: 'queued' })
    expect((await service.getJobLog(job!.id)).complete).toBe(false)
    await expect(service.getJobLog(999)).rejects.toBeInstanceOf(ServiceError)
    await expect(service.getJob(999)).rejects.toMatchObject({ code: 'not_found' })
  })

  test('finalise falls back to runner after the retry budget without touching a job that is already final', async () => {
    const w = await fresh()
    const job = await insertJobIfNew({ repo: 'acme/app', githubJobId: 6, runId: 1, name: 'x', labels: [], htmlUrl: '', queuedAt: '2026-01-01T00:00:00Z', status: 'completed' })
    await finalise((await jobById(job!.id))!)
    expect((await jobById(job!.id))!.logSource).toBe('runner')
    w.github.jobLogs.set('acme/app#6', '2026-01-01T00:00:00.0000000Z late')
    await finalise((await jobById(job!.id))!) // the GitHub log is available now: it still wins
    expect((await service.getJobLog(job!.id)).source).toBe('github')
  })

  test('retention purge removes the log lines with their jobs', async () => {
    const w = await fresh()
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
    await w.db.run(sql`insert into jobs (repo, github_job_id, run_id, name, labels, status, html_url, queued_at, completed_at, log_source)
      values ('a/b', 1, 1, 'old-done', '[]', 'completed', '', ${old}, ${old}, 'github'),
             ('a/b', 2, 1, 'recent', '[]', 'in_progress', '', ${new Date().toISOString()}, null, null)`)
    await w.db.run(sql`insert into job_logs (job_id, seq, at, line) values (1, 1, ${old}, 'old'), (1, 2, ${old}, 'old2'), (2, 1, ${old}, 'keep')`)
    expect((await purgeRetention()).jobs).toBe(1)
    const rows = await w.db.all<{ job_id: number; line: string }>(sql`select job_id, line from job_logs order by job_id, seq`)
    expect(rows.map((r) => [Number(r.job_id), r.line])).toEqual([[2, 'keep']])
  })

  test('scheduler tick keeps following through reap', async () => {
    const w = await fresh()
    const { runner, feed } = await spawnOne(w)
    await tick()
    expect(isFollowing(runner.id)).toBe(true)
    feed.push('x')
    w.docker.exit(runner.containerId!)
    await settled()
    await tick()
    expect((await runnerById(runner.id))!.state).toBe('exited')
    expect(isFollowing(runner.id)).toBe(false)
  })
})

/** Job 87 on GitHub: its details and its flat log. */
function serveJob87(w: Awaited<ReturnType<typeof fresh>>, githubJobId: number) {
  w.github.jobDetails.set(`acme/app#${githubJobId}`, job87Details())
  w.github.jobLogs.set(`acme/app#${githubJobId}`, job87Flat())
}

describe('job 87: the flat log split by time and step openers', () => {
  test('Standard gets its 96 lines with the ##[error], Complete job gets 1; annotations are stored', async () => {
    const w = await fresh()
    const { runner, feed, jobId } = await spawnOne(w, 87)
    serveJob87(w, 87)
    w.github.annotations.set('acme/app#87', [{ level: 'failure', message: 'Process completed with exit code 1.', title: null, path: '.github', startLine: 1, endLine: 1 }])
    feed.push('live line')
    w.docker.exit(runner.containerId!)
    await settled()
    const log = await service.getJobLog(jobId)
    expect(log.source).toBe('github')
    expect(log.lines).toHaveLength(509)
    expect(log.lines.every((l) => l.step === undefined)).toBe(true)
    const job = await service.getJob(jobId)
    expect(job.annotations).toEqual([{ level: 'failure', message: 'Process completed with exit code 1.', title: null, path: '.github', startLine: 1, endLine: 1 }])
    // standardrb printed its output in the second Post and Complete job started: it stays under Standard until the
    // next step's opener line; every step gets the lines GitHub shows under it
    const blocks = stepBlocks(job, log.lines)
    expect(blocks.map((b) => [b.step.number, b.lines.length])).toEqual([[1, 16], [2, 86], [3, 272], [4, 96], [8, 32], [9, 1]])
    const standard = blocks.find((b) => b.step.name === 'Standard')!
    expect(standard.lines.at(-1)!.line).toBe('##[error]Process completed with exit code 1.')
    expect(standard.errors).toBe(1)
    expect(standard.open).toBe(true)
    expect(blocks.find((b) => b.step.name === 'Complete job')!.lines.map((l) => l.line)).toEqual(['Cleaning up orphan processes'])
  })

  test('a failed annotations call keeps the log', async () => {
    const w = await fresh()
    const { runner, jobId } = await spawnOne(w, 89)
    serveJob87(w, 89)
    w.github.failOn.set('listJobAnnotations', 'Resource not accessible by integration')
    w.docker.exit(runner.containerId!)
    await settled()
    const log = await service.getJobLog(jobId)
    expect(log.source).toBe('github')
    expect(log.lines).toHaveLength(509)
    expect((await service.getJob(jobId)).annotations).toEqual([])
  })
})

describe('log line parsing', () => {
  test('docker timestamps are split off; untimestamped lines get a current stamp', () => {
    expect(parseTimestampedLine('2026-01-02T03:04:05.123456789Z hello world')).toEqual({ at: '2026-01-02T03:04:05.123456789Z', line: 'hello world' })
    expect(parseTimestampedLine('2026-01-02T03:04:05.123456789Z ')).toEqual({ at: '2026-01-02T03:04:05.123456789Z', line: '' })
    const plain = parseTimestampedLine('no stamp here')
    expect(plain.line).toBe('no stamp here')
    expect(Number.isNaN(Date.parse(plain.at))).toBe(false)
  })

  test('GitHub logs: trailing blank lines dropped, CRLF accepted, unstamped lines inherit the previous stamp', () => {
    expect(parseGitHubLog('2026-01-01T00:00:01.0000000Z a\r\nb\r\n2026-01-01T00:00:02.0000000Z c\r\n\r\n')).toEqual([
      { at: '2026-01-01T00:00:01.0000000Z', line: 'a' },
      { at: '2026-01-01T00:00:01.0000000Z', line: 'b' },
      { at: '2026-01-01T00:00:02.0000000Z', line: 'c' },
    ])
    expect(parseGitHubLog('')).toEqual([])
    // each of GitHub's files starts with a byte-order mark, the stamp behind it still counts
    expect(parseGitHubLog('\uFEFF2026-01-01T00:00:01.0000000Z a')).toEqual([{ at: '2026-01-01T00:00:01.0000000Z', line: 'a' }])
  })
})

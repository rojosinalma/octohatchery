import { describe, expect, test } from 'bun:test'
import { fresh, TEST_HOST } from './helpers'
import { settled } from '../../src/lib/joblog'
import { claim, reap } from '../../src/lib/scheduler'
import { service } from '../../src/lib/service'
import { removeStaleRunners } from '../../src/lib/sweep'
import { appendLogLines, insertJobIfNew, jobByGitHubId, jobById, logTail, markRunnerStarted, rebindJob, runnerById, updateRunner, type RunnerRow } from '../../src/lib/store'
import { applyWorkflowJob, type WorkflowJobPayload } from '../../src/lib/webhook'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function event(action: WorkflowJobPayload['action'], id: number, runner: string | null, extra: Partial<WorkflowJobPayload['workflow_job']> = {}): WorkflowJobPayload {
  return {
    action,
    workflow_job: { id, run_id: 77, name: `job-${id}`, labels: ['self-hosted', 'generic'], status: action, html_url: '', runner_name: runner, ...extra },
    repository: { full_name: 'acme/app' },
  }
}

/** Adopt, `slots` generic slots on this host, queue `ids` and claim them all: runners in claim order. */
async function claimed(ids: number[], slots = ids.length): Promise<RunnerRow[]> {
  await service.adoptRepo('acme/app', 'user')
  await service.setSlots({ host: TEST_HOST, type: 'generic', count: slots }, 'user')
  for (const id of ids) {
    await insertJobIfNew({ repo: 'acme/app', githubJobId: id, runId: 77, name: `job-${id}`, labels: ['self-hosted', 'generic'], htmlUrl: '', queuedAt: `2026-01-01T00:00:0${id}Z`, status: 'queued' })
  }
  const runners = await claim()
  expect(runners).toHaveLength(Math.min(ids.length, slots))
  return runners
}

describe('runner-job binding follows GitHub', () => {
  test('swapped runners: in_progress moves each job to the runner GitHub names, completion exits that runner only', async () => {
    const w = await fresh()
    const [a, b] = await claimed([1, 2])
    expect([a!.jobId, b!.jobId]).toEqual([(await jobByGitHubId(1))!.id, (await jobByGitHubId(2))!.id])

    await applyWorkflowJob(event('in_progress', 1, b!.name))
    let j1 = await jobByGitHubId(1)
    let j2 = await jobByGitHubId(2)
    expect(j1?.runnerId).toBe(b!.id)
    expect(j2?.runnerId).toBe(a!.id) // the displaced job takes the job's old runner
    expect((await runnerById(b!.id))).toMatchObject({ jobId: j1!.id, jobName: 'job-1', state: 'busy' })
    expect((await runnerById(a!.id))).toMatchObject({ jobId: j2!.id, jobName: 'job-2' })

    // the second delivery already matches: nothing moves again
    await applyWorkflowJob(event('in_progress', 2, a!.name))
    j2 = await jobByGitHubId(2)
    expect(j2?.runnerId).toBe(a!.id)
    expect((await runnerById(a!.id))?.state).toBe('busy')

    // job 2 ends first (the leaks/lint case): its own runner exits, the runner of job 1 keeps running
    await applyWorkflowJob(event('completed', 2, a!.name, { conclusion: 'success' }))
    expect((await runnerById(a!.id))?.state).toBe('exited')
    expect((await runnerById(b!.id))?.state).toBe('busy')
    await reap()
    expect(w.docker.containers.has(b!.containerId!)).toBe(true)
    j1 = await jobByGitHubId(1)
    expect(j1?.status).toBe('in_progress')
    const events = await service.listEvents()
    expect(events.filter((e) => e.action === 'job.rebound').map((e) => e.target)).toEqual(['acme/app#1'])
  })

  test('live lines move with their runner; seqs stay consecutive', async () => {
    await fresh()
    const [a, b] = await claimed([1, 2])
    const j1 = a!.jobId!
    const j2 = b!.jobId!
    await appendLogLines(j1, 1, [{ at: '2026-01-01T00:00:01Z', line: 'a1' }, { at: '2026-01-01T00:00:02Z', line: 'a2' }])
    await appendLogLines(j2, 1, [{ at: '2026-01-01T00:00:01Z', line: 'b1' }])
    await rebindJob(j1, b!.name)
    expect((await logTail(j1, 10)).map((l) => [l.seq, l.line])).toEqual([[1, 'b1']])
    expect((await logTail(j2, 10)).map((l) => [l.seq, l.line])).toEqual([[1, 'a1'], [2, 'a2']])
  })

  test('the follower writes to the job its runner runs now and finalises that job', async () => {
    const w = await fresh()
    const [a, b] = await claimed([1, 2])
    const feedB = w.docker.feed(b!.containerId!)
    feedB.push('runner b boots')
    await wait(40)
    await applyWorkflowJob(event('in_progress', 1, b!.name))
    feedB.push('job 1 output')
    await wait(40)
    const j1 = (await jobByGitHubId(1))!
    const j2 = (await jobByGitHubId(2))!
    expect((await logTail(j1.id, 10)).map((l) => l.line)).toEqual(['runner b boots', 'job 1 output'])
    expect(await logTail(j2.id, 10)).toEqual([])
    w.github.jobLogs.set('acme/app#1', '2026-01-01T00:00:01.0000000Z final log of job 1')
    w.docker.exit(b!.containerId!)
    w.docker.exit(a!.containerId!)
    await wait(30)
    await settled()
    expect((await jobById(j1.id))?.logSource).toBe('github')
    expect((await logTail(j1.id, 10)).map((l) => l.line)).toEqual(['final log of job 1'])
    // runner a printed nothing and GitHub has no log for job 2 here: it keeps its (empty) runner output
    expect((await jobById(j2.id))?.logSource).toBe('runner')
    expect(await logTail(j2.id, 10)).toEqual([])
  })

  test('a job no runner was claimed for, taken by a claimed runner: the displaced job goes back to the queue', async () => {
    await fresh()
    const [b] = await claimed([2, 3], 1) // only job 2 gets a runner; job 3 stays queued
    const j3 = (await jobByGitHubId(3))!
    expect(j3.status).toBe('queued')
    await applyWorkflowJob(event('in_progress', 3, b!.name))
    expect((await jobByGitHubId(3))).toMatchObject({ status: 'in_progress', runnerId: b!.id })
    expect((await jobByGitHubId(2))).toMatchObject({ status: 'queued', runnerId: null })
  })

  test('completed without an in_progress delivery still rebinds before it exits a runner', async () => {
    await fresh()
    const [a, b] = await claimed([1, 2])
    await applyWorkflowJob(event('completed', 1, b!.name, { conclusion: 'success' }))
    expect((await runnerById(b!.id))?.state).toBe('exited')
    expect((await runnerById(a!.id))?.state).toBe('idle')
    expect((await jobByGitHubId(2))?.runnerId).toBe(a!.id)
  })

  test('a runner name that is not ours leaves the binding alone', async () => {
    await fresh()
    const [a] = await claimed([1])
    await applyWorkflowJob(event('in_progress', 1, 'someone-elses-runner'))
    expect((await jobByGitHubId(1))?.runnerId).toBe(a!.id)
    expect((await runnerById(a!.id))?.state).toBe('busy')
  })

  test('the spawn finishing after GitHub marked the runner busy keeps it busy', async () => {
    await fresh()
    const [a] = await claimed([1])
    await updateRunner(a!.id, { state: 'busy' })
    const after = await markRunnerStarted(a!.id, { containerId: a!.containerId!, githubRunnerId: a!.githubRunnerId!, repo: 'acme/app' })
    expect(after?.state).toBe('busy')
    await updateRunner(a!.id, { state: 'spawning' })
    expect((await markRunnerStarted(a!.id, { containerId: 'c', githubRunnerId: 1, repo: 'acme/app' }))?.state).toBe('idle')
  })

  test('the stale sweep keeps a runner GitHub reports busy, and one whose state it cannot read', async () => {
    const w = await fresh()
    const [a] = await claimed([1])
    const later = Date.now() + 10 * 60_000
    w.github.busyRunners.add(a!.githubRunnerId!)
    expect(await removeStaleRunners(later)).toBe(0)
    expect((await runnerById(a!.id))?.state).toBe('busy')
    expect(w.docker.containers.has(a!.containerId!)).toBe(true)

    await updateRunner(a!.id, { state: 'idle' })
    w.github.getRunner = async () => {
      throw new Error('GitHub is down')
    }
    expect(await removeStaleRunners(later)).toBe(0)
    expect((await runnerById(a!.id))?.state).toBe('idle')
    expect(w.github.deletedRunners).toHaveLength(0)
  })
})

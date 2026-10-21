import { describe, expect, test } from 'bun:test'
import { fresh, TEST_HOST } from './helpers'
import { fakeJobDetails } from '../../src/lib/github/auth/none'
import type { JobDetails } from '../../src/lib/github/types'
import { isFollowing, settled } from '../../src/lib/joblog'
import { reconcileJob } from '../../src/lib/reconcile'
import { claim, reap } from '../../src/lib/scheduler'
import { service } from '../../src/lib/service'
import { insertJobIfNew, jobByGitHubId, jobById, runnerById, updateJob, type RunnerRow } from '../../src/lib/store'
import { reconcileJobs } from '../../src/lib/sweep'

const details = (patch: Partial<JobDetails>): JobDetails => ({ ...fakeJobDetails(), ...patch })
const running = (runnerName: string | null): JobDetails => details({ status: 'in_progress', conclusion: null, startedAt: new Date().toISOString(), completedAt: null, runnerName, steps: [] })

/** Adopt, `slots` generic slots on this host, queue `ids` and claim them: runners in claim order. */
async function claimed(ids: number[], slots = ids.length): Promise<RunnerRow[]> {
  await service.adoptRepo('acme/app', 'user')
  await service.setSlots({ host: TEST_HOST, type: 'generic', count: slots }, 'user')
  for (const id of ids) {
    await insertJobIfNew({ repo: 'acme/app', githubJobId: id, runId: 77, name: `job-${id}`, labels: ['self-hosted', 'generic'], htmlUrl: '', queuedAt: new Date().toISOString(), status: 'queued' })
  }
  const runners = await claim()
  expect(runners).toHaveLength(Math.min(ids.length, slots))
  return runners
}

/** A job row as the old reaper left it: completed with a guessed conclusion, no runner. */
async function closedJob(id: number, conclusion: string, completedAt = new Date().toISOString()) {
  const job = await insertJobIfNew({ repo: 'acme/app', githubJobId: id, runId: 77, name: `job-${id}`, labels: ['self-hosted', 'generic'], htmlUrl: '', queuedAt: completedAt, status: 'queued' })
  return updateJob(job!.id, { status: 'completed', conclusion, completedAt })
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const getJobCalls = (w: Awaited<ReturnType<typeof fresh>>) => w.github.calls.filter((c) => c.method === 'getJob')

describe('reconcile with the GitHub job API when a webhook is missing', () => {
  test('the reaper takes the conclusion from GitHub, whatever the runner exit code', async () => {
    const w = await fresh()
    const [a, b] = await claimed([1, 2])
    w.github.jobDetails.set('acme/app#1', details({ runnerName: a!.name }))
    w.github.jobDetails.set('acme/app#2', details({ runnerName: b!.name, conclusion: 'cancelled' }))
    w.docker.exit(a!.containerId!, 1)
    w.docker.exit(b!.containerId!, 0)
    await reap()
    await settled()
    expect(await jobByGitHubId(1)).toMatchObject({ status: 'completed', conclusion: 'success', completedAt: '2026-01-01T00:02:00Z', runnerId: a!.id })
    expect(await jobByGitHubId(2)).toMatchObject({ status: 'completed', conclusion: 'cancelled', runnerId: b!.id })
    const events = (await service.listEvents()).filter((e) => e.action === 'job.reconciled')
    expect(events.map((e) => [e.actor, e.target]).sort()).toEqual([
      ['github', 'acme/app#1'],
      ['github', 'acme/app#2'],
    ])
    expect(events.find((e) => e.target === 'acme/app#1')?.detail).toMatchObject({ fromStatus: 'claimed', toStatus: 'completed', fromConclusion: null, toConclusion: 'success' })
  })

  test('a reconcile that changes nothing records no event', async () => {
    const w = await fresh()
    await claimed([1])
    const job = (await jobByGitHubId(1))!
    w.github.jobDetails.set('acme/app#1', details({ status: 'queued', conclusion: null, startedAt: null, completedAt: null, steps: [] }))
    const r = await reconcileJob(job)
    expect(r?.changed).toBe(false)
    expect((await jobById(job.id))?.status).toBe('claimed') // its runner is live: still ours to take
    expect((await service.listEvents()).some((e) => e.action === 'job.reconciled')).toBe(false)
  })

  test('the runner GitHub names gets the job; the job this runner holds after the rebind is settled next', async () => {
    const w = await fresh()
    const [a, b] = await claimed([1, 2])
    // a ran job 2 and exited; b runs job 1
    w.github.jobDetails.set('acme/app#1', running(b!.name))
    w.github.jobDetails.set('acme/app#2', details({ runnerName: a!.name }))
    w.docker.exit(a!.containerId!, 0)
    await reap()
    while (isFollowing(a!.id)) await wait(10) // b keeps running, so only a's follower can settle
    expect(await jobByGitHubId(1)).toMatchObject({ status: 'in_progress', runnerId: b!.id })
    expect(await jobByGitHubId(2)).toMatchObject({ status: 'completed', conclusion: 'success', runnerId: a!.id })
    expect(await runnerById(a!.id)).toMatchObject({ state: 'exited', jobName: 'job-2' })
    expect(await runnerById(b!.id)).toMatchObject({ jobName: 'job-1' })
    expect(w.docker.containers.has(b!.containerId!)).toBe(true)
    const rebound = (await service.listEvents()).filter((e) => e.action === 'job.rebound')
    expect(rebound.map((e) => [e.actor, e.target])).toEqual([['github', 'acme/app#1']])
  })

  test('a job GitHub reports still running elsewhere stays open and is unbound from the exited runner', async () => {
    const w = await fresh()
    const [a] = await claimed([1])
    w.github.jobDetails.set('acme/app#1', running('someone-elses-runner'))
    w.docker.exit(a!.containerId!, 1)
    await reap()
    await settled()
    expect(await jobByGitHubId(1)).toMatchObject({ status: 'in_progress', conclusion: null, runnerId: null })
    expect(await runnerById(a!.id)).toMatchObject({ state: 'exited', jobId: null })
    expect((await jobByGitHubId(1))?.logSource).toBeNull() // no final log fetched for a job that runs elsewhere
  })

  test('a job GitHub still has queued goes back to the queue when its runner is gone', async () => {
    const w = await fresh()
    const [a] = await claimed([1])
    w.github.jobDetails.set('acme/app#1', details({ status: 'queued', conclusion: null, startedAt: null, completedAt: null, steps: [] }))
    w.docker.exit(a!.containerId!, 2)
    await reap()
    await settled()
    expect(await jobByGitHubId(1)).toMatchObject({ status: 'queued', runnerId: null })
    const [next] = await claim()
    expect(next?.jobName).toBe('job-1')
  })

  test('GitHub not reachable: the reaper closes the job as unknown, never failure, and the row is kept otherwise', async () => {
    const w = await fresh()
    const [a] = await claimed([1])
    w.github.failOn.set('getJob', 'rate limited')
    const before = (await jobByGitHubId(1))!
    expect(await reconcileJob(before)).toBeNull()
    expect(await jobById(before.id)).toEqual(before)
    w.docker.exit(a!.containerId!, 1)
    await reap()
    await settled()
    expect(await jobByGitHubId(1)).toMatchObject({ status: 'completed', conclusion: 'unknown' })

    // the sweep asks again once GitHub answers
    w.github.failOn.delete('getJob')
    expect(await reconcileJobs()).toBe(1)
    expect(await jobByGitHubId(1)).toMatchObject({ status: 'completed', conclusion: 'success' })
  })

  test('the finaliser takes status and conclusion from GitHub even without a webhook', async () => {
    const w = await fresh()
    const [a] = await claimed([1])
    w.github.jobDetails.set('acme/app#1', details({ runnerName: a!.name, conclusion: 'failure' }))
    w.github.jobLogs.set('acme/app#1', '2026-01-01T00:00:01.0000000Z Done')
    w.docker.exit(a!.containerId!, 0)
    await settled() // the follower ends and finalises before the reaper runs
    expect(await jobByGitHubId(1)).toMatchObject({ status: 'completed', conclusion: 'failure', logSource: 'github' })
  })

  test('the sweep reconciles at most 10 jobs per pass, completed ones once per process, open ones again after the poll interval', async () => {
    const w = await fresh()
    await service.adoptRepo('acme/app', 'user')
    for (let id = 1; id <= 12; id++) await closedJob(id, id % 2 ? 'unknown' : 'failure')
    await closedJob(50, 'unknown', new Date(Date.now() - 25 * 3_600_000).toISOString()) // outside the 24 h window
    await closedJob(51, 'success') // a webhook's conclusion: nothing to check
    const open = await insertJobIfNew({ repo: 'acme/app', githubJobId: 60, runId: 77, name: 'job-60', labels: ['self-hosted', 'generic'], htmlUrl: '', queuedAt: new Date().toISOString(), status: 'queued' })
    await updateJob(open!.id, { status: 'in_progress', startedAt: new Date().toISOString() })
    w.github.jobDetails.set('acme/app#60', running('someone-elses-runner'))
    for (const id of [2, 4]) w.github.jobDetails.set(`acme/app#${id}`, details({ conclusion: 'failure' })) // real failures stay

    const now = Date.now()
    expect(await reconcileJobs(10, now)).toBe(8) // newest first: job 60 (no change) and jobs 12..4; 4 is a real failure
    expect(getJobCalls(w)).toHaveLength(10)
    expect(await reconcileJobs(10, now)).toBe(2) // the rest: 3, 1 (2 is a real failure)
    expect(getJobCalls(w)).toHaveLength(13)
    expect(await reconcileJobs(10, now)).toBe(0) // nothing left this process; job 60 waits for the poll interval
    expect(getJobCalls(w)).toHaveLength(13)
    expect(await reconcileJobs(10, now + 301_000)).toBe(0)
    expect(getJobCalls(w).map((c) => c.args[1])).toEqual([60, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 60])

    for (let id = 1; id <= 12; id++) expect((await jobByGitHubId(id))?.conclusion).toBe(id === 2 || id === 4 ? 'failure' : 'success')
    expect((await jobByGitHubId(50))?.conclusion).toBe('unknown')
  })
})

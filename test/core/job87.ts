// Job 87 (test/fixtures/job87, see its README): GitHub's run-attempt archive and the steps GitHub reported.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import type { JobDetails } from '../../src/lib/github/types'

const DIR = join(import.meta.dir, '../fixtures/job87')

export const job87Zip = (): Uint8Array => new Uint8Array(readFileSync(join(DIR, 'run-attempt-logs.zip')))

/**
 * The job's whole log as GitHub's job log endpoint returns it: the archive's flat `0_lint.txt` without the
 * `system.txt` lines it ends with (the endpoint leaves them out: 509 lines).
 */
export const job87Flat = (): string => {
  const files = unzipSync(job87Zip(), { filter: (f) => f.name === '0_lint.txt' || f.name === 'lint/system.txt' })
  const flat = strFromU8(files['0_lint.txt']!)
  const system = strFromU8(files['lint/system.txt']!).replace(/^\uFEFF/, '')
  return flat.endsWith(system) ? flat.slice(0, -system.length) : flat
}

const step = (number: number, name: string, startedAt: string, completedAt: string, conclusion = 'success') => ({ number, name, status: 'completed', conclusion, startedAt, completedAt })

/** `GET /actions/jobs/{id}` for job 87: second-precision step times, run 9001 attempt 1. */
export const job87Details = (): JobDetails => ({
  status: 'completed',
  conclusion: 'failure',
  startedAt: '2026-10-21T11:28:40Z',
  completedAt: '2026-10-21T11:29:54Z',
  runId: 9001,
  runAttempt: 1,
  name: 'lint',
  steps: [
    step(1, 'Set up job', '2026-10-21T11:28:42Z', '2026-10-21T11:28:43Z'),
    step(2, 'Run actions/checkout@v7', '2026-10-21T11:28:43Z', '2026-10-21T11:28:45Z'),
    step(3, 'Run ruby/setup-ruby@v1', '2026-10-21T11:28:45Z', '2026-10-21T11:29:36Z'),
    step(4, 'Standard', '2026-10-21T11:29:36Z', '2026-10-21T11:29:51Z', 'failure'),
    step(8, 'Post Run actions/checkout@v7', '2026-10-21T11:29:51Z', '2026-10-21T11:29:51Z'),
    step(9, 'Complete job', '2026-10-21T11:29:51Z', '2026-10-21T11:29:51Z'),
  ],
})

// Job 87 (test/fixtures/job87, see its README): GitHub's flat job log and the steps GitHub reported.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JobDetails } from '../../src/lib/github/types'

/** The job's whole log as GitHub's job log endpoint returns it (509 lines). */
export const job87Flat = (): string => readFileSync(join(import.meta.dir, '../fixtures/job87/lint.txt'), 'utf8')

const step = (number: number, name: string, startedAt: string, completedAt: string, conclusion = 'success') => ({ number, name, status: 'completed', conclusion, startedAt, completedAt })

/** `GET /actions/jobs/{id}` for job 87: second-precision step times. */
export const job87Details = (): JobDetails => ({
  status: 'completed',
  conclusion: 'failure',
  startedAt: '2026-10-21T11:28:40Z',
  completedAt: '2026-10-21T11:29:54Z',
  steps: [
    step(1, 'Set up job', '2026-10-21T11:28:42Z', '2026-10-21T11:28:43Z'),
    step(2, 'Run actions/checkout@v7', '2026-10-21T11:28:43Z', '2026-10-21T11:28:45Z'),
    step(3, 'Run ruby/setup-ruby@v1', '2026-10-21T11:28:45Z', '2026-10-21T11:29:36Z'),
    step(4, 'Standard', '2026-10-21T11:29:36Z', '2026-10-21T11:29:51Z', 'failure'),
    step(8, 'Post Run actions/checkout@v7', '2026-10-21T11:29:51Z', '2026-10-21T11:29:51Z'),
    step(9, 'Complete job', '2026-10-21T11:29:51Z', '2026-10-21T11:29:51Z'),
  ],
})

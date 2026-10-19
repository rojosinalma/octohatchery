import { z } from 'zod'
import { service } from '../../lib/service'
import { defineTool } from './define'
import { repoName } from './adopt_repo'

export const listJobs = defineTool({
  name: 'list_jobs',
  description:
    'List workflow jobs seen from adopted repos, newest first: repo, name, labels, status (queued, claimed, in_progress, completed, ignored), ' +
    'conclusion, runner id and timestamps. Filter by repo and/or status; limit defaults to the server default. ' +
    'Use it to see the queue or to find why a job did not run (status ignored = no matching runner type). Returns an array of jobs.',
  inputSchema: {
    repo: repoName.optional(),
    status: z.enum(['queued', 'claimed', 'in_progress', 'completed', 'ignored']).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
  destructive: false,
  handler: (args) => service.listJobs(args),
})

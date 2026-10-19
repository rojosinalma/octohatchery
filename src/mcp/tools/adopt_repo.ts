import { z } from 'zod'
import { service } from '../../lib/service'
import { defineTool } from './define'

export const repoName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'use the form owner/name')

export const adoptRepo = defineTool({
  name: 'adopt_repo',
  description:
    'Adopt a repository (owner/name): queued jobs from it get runners from now on, and a workflow_job webhook is created on the repo when needed. ' +
    'Use it once per repo, then apply_runs_on to point workflows at a runner type. Idempotent. Returns the repo row.',
  inputSchema: { repo: repoName },
  destructive: false,
  handler: (args, ctx) => service.adoptRepo(args.repo, ctx.actor),
})

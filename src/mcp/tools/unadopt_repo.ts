import { z } from 'zod'
import { service } from '../../lib/service'
import { adoptRepo, repoName } from './adopt_repo'
import { defineTool } from './define'

export const unadoptRepo = defineTool({
  name: 'unadopt_repo',
  description:
    'DESTRUCTIVE: stop serving a repository. New jobs from it are ignored and the webhook this orchestrator created is removed. ' +
    `Running jobs finish. Workflows are not edited; use apply_runs_on to move them back. Undo with ${adoptRepo.name}. Returns {unadopted: repo}.`,
  inputSchema: { repo: repoName },
  destructive: true,
  handler: async (args, ctx) => {
    await service.unadoptRepo(args.repo, ctx.actor)
    return { unadopted: args.repo }
  },
})

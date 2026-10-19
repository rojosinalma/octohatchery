import { z } from 'zod'
import { service } from '../../lib/service'
import { repoName } from './adopt_repo'
import { defineTool } from './define'

export const applyRunsOn = defineTool({
  name: 'apply_runs_on',
  description:
    'Produce or apply the runs-on line that sends a repo\'s workflows to a runner type. ' +
    'mode "snippet" only returns the YAML to paste (safe, no write). ' +
    'mode "pr" WRITES to GitHub: it edits the workflow files on a branch and opens a pull request. ' +
    'mode "commit" WRITES to GitHub: it commits the edit straight to the default branch; use it only when asked explicitly. ' +
    'host pins the jobs to one host; workflows limits the edit to the given paths under .github/workflows (default: all). ' +
    'Returns {ok, message, snippet?, prUrl?, commitSha?, files?}.',
  inputSchema: {
    repo: repoName,
    mode: z.enum(['snippet', 'pr', 'commit']),
    type: z.string().min(1),
    host: z.string().min(1).optional(),
    workflows: z.array(z.string().min(1)).max(100).optional(),
  },
  destructive: true,
  handler: (args, ctx) =>
    service.applyRunsOn(
      { fullName: args.repo, mode: args.mode, type: args.type, host: args.host, workflows: args.workflows },
      ctx.actor,
    ),
})

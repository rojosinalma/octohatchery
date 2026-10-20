import { service } from '../../lib/service'
import { defineTool } from './define'
import { repoName } from './adopt_repo'

export const ensureWebhook = defineTool({
  name: 'ensure_webhook',
  description:
    'Create or repair the workflow_job webhook of an adopted repository (owner/name) so queued jobs arrive at once instead of on the next poll. ' +
    'With a personal access token the hook is created on the repo and its id stored; with a GitHub App nothing is created (the App delivers the events) ' +
    'and the result says covered: "app". Idempotent. Returns {repo, covered, created}.',
  inputSchema: { repo: repoName },
  destructive: false,
  handler: (args, ctx) => service.ensureWebhook(args.repo, ctx.actor),
})

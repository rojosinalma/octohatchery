import { service } from '../../lib/service'
import { defineTool } from './define'

export const listRepos = defineTool({
  name: 'list_repos',
  description:
    'List the repositories the GitHub credentials can see, with adopted flag, visibility and webhook id. ' +
    'Only adopted repos get runners. Use it to find a repo name before adopt_repo or apply_runs_on. Returns an array of repos.',
  inputSchema: {},
  destructive: false,
  handler: () => service.listRepos(),
})

import { z } from 'zod'
import { service } from '../../lib/service'
import { defineTool } from './define'

export const kill = defineTool({
  name: 'kill',
  description:
    'DESTRUCTIVE: stop and remove one runner container by its runner_id (from list_runners). A job running on it fails on GitHub and is not retried here. ' +
    'Use it for a stuck or unwanted runner. Returns {killed: runner_id}.',
  inputSchema: { runner_id: z.number().int().positive() },
  destructive: true,
  handler: async (args, ctx) => {
    await service.kill(args.runner_id, ctx.actor)
    return { killed: args.runner_id }
  },
})

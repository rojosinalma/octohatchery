import { z } from 'zod'
import { service } from '../../lib/service'
import { defineTool } from './define'

export const listRunners = defineTool({
  name: 'list_runners',
  description:
    'List runner containers, newest first: name, host, type, container id, state (spawning, idle, busy, exited, failed, removed) and the job it runs. ' +
    'Filter by host and/or state. Use it to see what is running where, or to find a runner_id for kill. Returns an array of runners.',
  inputSchema: {
    host: z.string().min(1).optional(),
    state: z.enum(['spawning', 'idle', 'busy', 'exited', 'failed', 'removed']).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
  destructive: false,
  handler: (args) => service.listRunners(args),
})

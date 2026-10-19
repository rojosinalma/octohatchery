import { z } from 'zod'
import { service } from '../../lib/service'
import { defineTool } from './define'

export const spawn = defineTool({
  name: 'spawn',
  description:
    'Start one runner of the given type on the given host by hand, outside the scheduler. It needs a free slot and registers a single-use runner ' +
    'that exits after one job or after the stale timeout. Use it to test a new runner type or to pre-warm a host. Returns the runner row.',
  inputSchema: {
    type: z.string().min(1),
    host: z.string().min(1),
  },
  destructive: false,
  handler: (args, ctx) => service.spawn(args, ctx.actor),
})

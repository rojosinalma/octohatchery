import { z } from 'zod'
import { service } from '../../lib/service'
import { defineTool } from './define'

export const setSlots = defineTool({
  name: 'set_slots',
  description:
    'Set how many runners of one type may run at once on one host. count 0 removes the host from that type. ' +
    'Use it to add capacity on a host or to drain it. Running runners are not killed. Returns the updated slot {host, type, count, used, free}.',
  inputSchema: {
    host: z.string().min(1),
    type: z.string().min(1),
    count: z.number().int().min(0).max(1000),
  },
  destructive: false,
  handler: (args, ctx) => service.setSlots(args, ctx.actor),
})

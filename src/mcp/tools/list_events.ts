import { z } from 'zod'
import { service } from '../../lib/service'
import { defineTool } from './define'

export const listEvents = defineTool({
  name: 'list_events',
  description:
    'List the audit log, newest first: who (actor: user, mcp:<client>, webhook, scheduler, sweep) did what (action) to which target, with detail and time. ' +
    'Use it to trace a change or a spawn/kill. Returns an array of events.',
  inputSchema: { limit: z.number().int().min(1).max(500).optional() },
  destructive: false,
  handler: (args) => service.listEvents(args),
})

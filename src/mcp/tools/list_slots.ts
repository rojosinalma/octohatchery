import { service } from '../../lib/service'
import { defineTool } from './define'

export const listSlots = defineTool({
  name: 'list_slots',
  description:
    'List slots: for each host and runner type, how many runners may run at once (count), how many are running (used) and how many are free. ' +
    'Use it to see capacity before spawn or to explain why a job is still queued. Returns an array of slots.',
  inputSchema: {},
  destructive: false,
  handler: () => service.listSlots(),
})

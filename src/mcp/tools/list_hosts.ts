import { service } from '../../lib/service'
import { defineTool } from './define'

export const listHosts = defineTool({
  name: 'list_hosts',
  description:
    'List every node that runs this orchestrator: name, online/offline status, last seen time, leader flag and whether its local Docker answers. ' +
    'Use it first to learn which host names are valid for set_slots, spawn and apply_runs_on. Returns an array of hosts.',
  inputSchema: {},
  destructive: false,
  handler: () => service.listHosts(),
})

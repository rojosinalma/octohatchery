import { service } from '../../lib/service'
import { defineTool } from './define'

export const health = defineTool({
  name: 'health',
  description:
    'Health snapshot of the node that answers: ok flag, mode (single/cluster), host, DB and Docker reachability, leader flag, slots, queued jobs, busy runners, ' +
    'last webhook time, version and github {ok, source, missing[]} (missing permissions are a warning, not a failure). Use it first when something looks wrong. Returns one object.',
  inputSchema: {},
  destructive: false,
  handler: () => service.health(),
})

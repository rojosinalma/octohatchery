import { service } from '../../lib/service'
import { defineTool } from './define'

export const listRunnerTypes = defineTool({
  name: 'list_runner_types',
  description:
    'List the runner types (templates for runner containers): name, labels, image, CPU and memory caps, mounts, env and the names of secret env vars. ' +
    'Use it to find a valid type name before set_slots, spawn or apply_runs_on. Returns an array of runner types; secret values are never included.',
  inputSchema: {},
  destructive: false,
  handler: () => service.listRunnerTypes(),
})

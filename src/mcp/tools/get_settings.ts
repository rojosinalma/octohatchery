import { service } from '../../lib/service'
import { defineTool } from './define'

export const getSettings = defineTool({
  name: 'get_settings',
  description:
    'Read every runtime setting as key → value strings (poll_interval_s, stale_runner_minutes, retention_days, sse_max_clients, sse_idle_s, log_level, buildkit_host). ' +
    'Use it before set_setting. Secrets are not settings and never appear here. Returns an object.',
  inputSchema: {},
  destructive: false,
  handler: () => service.getSettings(),
})

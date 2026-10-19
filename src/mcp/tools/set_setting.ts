import { z } from 'zod'
import { service } from '../../lib/service'
import { defineTool } from './define'

export const setSetting = defineTool({
  name: 'set_setting',
  description:
    'Set one runtime setting by key. Values are strings; the server validates them and rejects unknown keys. Takes effect within a few seconds on every node. ' +
    'Use get_settings to see the keys. Returns {key, value}.',
  inputSchema: {
    key: z.string().min(1).max(64),
    value: z.string().max(1024),
  },
  destructive: false,
  handler: async (args, ctx) => {
    await service.setSetting(args.key, args.value, ctx.actor)
    return { key: args.key, value: args.value }
  },
})

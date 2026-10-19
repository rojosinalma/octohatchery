import { z } from 'zod'
import { service } from '../../lib/service'
import { defineTool } from './define'

export const deleteRunnerType = defineTool({
  name: 'delete_runner_type',
  description:
    'DESTRUCTIVE: delete a runner type by name. Jobs that select this type stop being picked up and its slots are removed. ' +
    'Fails when runners of this type are still alive. Use it only after you confirmed no workflow still targets the type. Returns {deleted: name}.',
  inputSchema: { name: z.string().min(1) },
  destructive: true,
  handler: async (args, ctx) => {
    await service.deleteRunnerType(args.name, ctx.actor)
    return { deleted: args.name }
  },
})

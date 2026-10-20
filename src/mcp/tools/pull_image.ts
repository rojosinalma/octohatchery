import { z } from 'zod'
import { service } from '../../lib/service'
import { defineTool } from './define'

export const pullImage = defineTool({
  name: 'pull_image',
  description:
    'Queue a pull of one image on one host. The node on that host runs it on its next scheduler tick and records the outcome; the image ' +
    'then shows as present on Templates → Images and in GET /api/hosts/:name/images. Only images the instance wants can be pulled: the image of ' +
    'a runner type, the default runner image or the docker:28-dind sidecar. A pull already queued or running for the same host and image is returned as is. ' +
    'Use it to warm a host before its first job of a new runner type. Returns the pull row (id, host, reference, status).',
  inputSchema: {
    host: z.string().min(1).max(63),
    reference: z.string().min(1).max(300),
  },
  destructive: false,
  handler: (args, ctx) => service.pullImage(args, ctx.actor),
})

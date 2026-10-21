import { z } from 'zod'
import { service } from '../../lib/service'
import { defineTool } from './define'

export const upsertRunnerType = defineTool({
  name: 'upsert_runner_type',
  description:
    'Create a runner type or replace an existing one with the same name. A runner type is the template a runner container is started from: ' +
    'image, labels (added to self-hosted, <type>, <host>), CPU and memory caps, extra mounts (src:dst[:ro]), plain env and the names of secret env vars ' +
    'that are resolved from the node at spawn time, and docker access: "none" (default: no daemon, image builds go through the shared BuildKit, services: and docker run fail), ' +
    '"socket" (the host\'s Docker socket is mounted: services:, docker run and Compose work, but every job on the type controls every container on the host) or ' +
    '"dind" (a privileged docker:dind sidecar per runner, isolated, slower to start, no shared image cache), ' +
    'and runAs: "image" (default: the user the image declares, uid 1001 "runner" in the shipped image) or "root" (uid 0, for jobs that write ' +
    'root-owned files in bind mounts; a root job can write any host path the type bind-mounts, and with docker "socket" it adds nothing because the socket already gives root on the host). ' +
    'Use it to add a GPU, arm64 or deploy type. Changes apply to runners spawned after the call. Returns the stored type.',
  inputSchema: {
    name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
    description: z.string().nullable().default(null),
    labels: z.array(z.string().min(1)).default([]),
    image: z.string().min(1),
    cpus: z.number().positive(),
    memoryMb: z.number().int().positive(),
    mounts: z.array(z.string().min(1)).default([]),
    env: z.record(z.string(), z.string()).default({}),
    secretEnv: z.array(z.string().min(1)).default([]),
    docker: z.enum(['none', 'socket', 'dind']).default('none'),
    runAs: z.enum(['image', 'root']).default('image'),
  },
  destructive: false,
  handler: (args, ctx) => service.upsertRunnerType(args, ctx.actor),
})

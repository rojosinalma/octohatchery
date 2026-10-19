import { sql } from 'drizzle-orm'
import type { Db } from './driver'

export const DEFAULT_RUNNER_IMAGE = 'ghcr.io/rojosinalma/octohatchery-runner:latest'

type SeedType = {
  name: string
  description: string
  labels: string[]
  image: string
  cpus: number
  memoryMb: number
  secretEnv: string[]
}

/** Runner types present after the first boot. Operators edit or add more as rows; slots stay empty until set. */
export const SEED_RUNNER_TYPES: readonly SeedType[] = [
  {
    name: 'deploy',
    description: 'Deploy lane: one slot per host, holds the deploy credentials',
    labels: [],
    image: DEFAULT_RUNNER_IMAGE,
    cpus: 1,
    memoryMb: 1024,
    secretEnv: ['DEPLOYER_TOKEN'],
  },
  {
    name: 'generic',
    description: 'General CI: builds via the buildkitd sidecar',
    labels: [],
    image: DEFAULT_RUNNER_IMAGE,
    cpus: 2,
    memoryMb: 4096,
    secretEnv: [],
  },
]

/** Idempotent: inserts the seed runner types only when missing. */
export async function seed(db: Db): Promise<void> {
  const now = new Date().toISOString()
  for (const t of SEED_RUNNER_TYPES) {
    await db.run(sql`
      insert into runner_types (name, description, labels, image, cpus, memory_mb, mounts, env, secret_env, created_at, updated_at)
      values (${t.name}, ${t.description}, ${JSON.stringify(t.labels)}, ${t.image}, ${t.cpus}, ${t.memoryMb}, '[]', '{}', ${JSON.stringify(t.secretEnv)}, ${now}, ${now})
      on conflict (name) do nothing`)
  }
}

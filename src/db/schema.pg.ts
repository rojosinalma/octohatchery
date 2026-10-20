import { bigint, boolean, index, integer, pgTable, primaryKey, real, serial, text, uniqueIndex } from 'drizzle-orm/pg-core'

// Postgres mirror of `schema.ts`: same tables, same column names, same semantics.
// GitHub ids exceed 32 bits, so they are bigint here (SQLite integers are already 64-bit).

export const hosts = pgTable('hosts', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  status: text('status').notNull().default('online'),
  lastSeenAt: text('last_seen_at').notNull(),
  isLeader: boolean('is_leader').notNull().default(false),
  dockerOk: boolean('docker_ok').notNull().default(false),
})

export const runnerTypes = pgTable('runner_types', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  labels: text('labels').notNull().default('[]'),
  image: text('image').notNull(),
  cpus: real('cpus').notNull().default(1),
  memoryMb: integer('memory_mb').notNull().default(1024),
  mounts: text('mounts').notNull().default('[]'),
  env: text('env').notNull().default('{}'),
  secretEnv: text('secret_env').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const slots = pgTable(
  'slots',
  {
    id: serial('id').primaryKey(),
    hostId: integer('host_id')
      .notNull()
      .references(() => hosts.id, { onDelete: 'cascade' }),
    runnerTypeId: integer('runner_type_id')
      .notNull()
      .references(() => runnerTypes.id, { onDelete: 'cascade' }),
    count: integer('count').notNull().default(0),
  },
  (t) => [uniqueIndex('slots_host_type').on(t.hostId, t.runnerTypeId)],
)

export const repos = pgTable('repos', {
  id: serial('id').primaryKey(),
  fullName: text('full_name').notNull().unique(),
  adopted: boolean('adopted').notNull().default(false),
  isPrivate: boolean('is_private').notNull().default(false),
  webhookId: bigint('webhook_id', { mode: 'number' }),
  adoptedAt: text('adopted_at'),
})

export const jobs = pgTable(
  'jobs',
  {
    id: serial('id').primaryKey(),
    repo: text('repo').notNull(),
    githubJobId: bigint('github_job_id', { mode: 'number' }).notNull().unique(),
    runId: bigint('run_id', { mode: 'number' }).notNull(),
    name: text('name').notNull(),
    labels: text('labels').notNull().default('[]'),
    status: text('status').notNull().default('queued'),
    conclusion: text('conclusion'),
    runnerId: integer('runner_id'),
    htmlUrl: text('html_url').notNull().default(''),
    retries: integer('retries').notNull().default(0),
    queuedAt: text('queued_at').notNull(),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    logSource: text('log_source'),
    logBytes: integer('log_bytes').notNull().default(0),
    logTruncated: boolean('log_truncated').notNull().default(false),
  },
  (t) => [index('jobs_status_queued').on(t.status, t.queuedAt), index('jobs_repo').on(t.repo)],
)

export const runners = pgTable(
  'runners',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    host: text('host').notNull(),
    type: text('type').notNull(),
    containerId: text('container_id'),
    state: text('state').notNull().default('spawning'),
    jobId: integer('job_id'),
    repo: text('repo'),
    jobName: text('job_name'),
    githubRunnerId: bigint('github_runner_id', { mode: 'number' }),
    createdAt: text('created_at').notNull(),
    exitedAt: text('exited_at'),
  },
  (t) => [index('runners_host_state').on(t.host, t.state)],
)

export const events = pgTable(
  'events',
  {
    id: serial('id').primaryKey(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    target: text('target').notNull(),
    detail: text('detail').notNull().default('{}'),
    at: text('at').notNull(),
  },
  (t) => [index('events_at').on(t.at)],
)

/** Log lines of one job, in order; deleted with the job. `at` is the line's own timestamp (runner or GitHub). */
export const jobLogs = pgTable(
  'job_logs',
  {
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    at: text('at').notNull(),
    line: text('line').notNull(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.seq] })],
)

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
})

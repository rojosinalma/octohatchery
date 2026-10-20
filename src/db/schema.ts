import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// Canonical schema (SQLite flavour). `schema.pg.ts` mirrors it for Postgres; a test keeps them in sync.
// Timestamps are ISO-8601 text and JSON columns are text in both dialects so one query layer serves both.

export const hosts = sqliteTable('hosts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  status: text('status').notNull().default('online'),
  lastSeenAt: text('last_seen_at').notNull(),
  isLeader: integer('is_leader', { mode: 'boolean' }).notNull().default(false),
  dockerOk: integer('docker_ok', { mode: 'boolean' }).notNull().default(false),
})

export const runnerTypes = sqliteTable('runner_types', {
  id: integer('id').primaryKey({ autoIncrement: true }),
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

export const slots = sqliteTable(
  'slots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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

export const repos = sqliteTable('repos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fullName: text('full_name').notNull().unique(),
  adopted: integer('adopted', { mode: 'boolean' }).notNull().default(false),
  isPrivate: integer('is_private', { mode: 'boolean' }).notNull().default(false),
  webhookId: integer('webhook_id'),
  adoptedAt: text('adopted_at'),
})

export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repo: text('repo').notNull(),
    githubJobId: integer('github_job_id').notNull().unique(),
    runId: integer('run_id').notNull(),
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
    logTruncated: integer('log_truncated', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('jobs_status_queued').on(t.status, t.queuedAt), index('jobs_repo').on(t.repo)],
)

export const runners = sqliteTable(
  'runners',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    host: text('host').notNull(),
    type: text('type').notNull(),
    containerId: text('container_id'),
    state: text('state').notNull().default('spawning'),
    jobId: integer('job_id'),
    repo: text('repo'),
    jobName: text('job_name'),
    githubRunnerId: integer('github_runner_id'),
    createdAt: text('created_at').notNull(),
    exitedAt: text('exited_at'),
  },
  (t) => [index('runners_host_state').on(t.host, t.state)],
)

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    target: text('target').notNull(),
    detail: text('detail').notNull().default('{}'),
    at: text('at').notNull(),
  },
  (t) => [index('events_at').on(t.at)],
)

/** Log lines of one job, in order; deleted with the job. `at` is the line's own timestamp (runner or GitHub). */
export const jobLogs = sqliteTable(
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

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
})

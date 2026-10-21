import type { GitHubStatus } from '../../src/lib/github/permissions'
import { ServiceError, type Event, type GitHubRepoItem, type HealthSnapshot, type Host, type HostImage, type ImagePull, type Job, type JobLog, type Repo, type RepoListItem, type Runner, type RunnerType, type Slot } from '../../src/lib/types'

export const hosts: Host[] = [
  { id: 1, name: 'node-a', status: 'online', lastSeenAt: '2026-10-19T10:00:00Z', isLeader: true, dockerOk: true, cpus: 8, memoryMb: 32768, os: 'Ubuntu 24.04.1 LTS', dockerVersion: '27.3.1', appVersion: '0.1.0-test' },
  { id: 2, name: 'node-b', status: 'offline', lastSeenAt: '2026-10-18T10:00:00Z', isLeader: false, dockerOk: false, cpus: null, memoryMb: null, os: null, dockerVersion: null, appVersion: null },
]

export const types: RunnerType[] = [
  {
    id: 1,
    name: 'generic',
    description: 'General purpose <builds>',
    labels: ['linux', 'x64'],
    image: 'ghcr.io/example/runner:1',
    cpus: 2,
    memoryMb: 4096,
    mounts: ['/srv/cache:/cache:ro'],
    env: { CI: 'true' },
    secretEnv: ['NPM_TOKEN'],
    docker: 'none',
    runAs: 'image',
    createdAt: '2026-10-19T09:00:00Z',
    updatedAt: '2026-10-19T09:00:00Z',
  },
]

export const slots: Slot[] = [
  { host: 'node-a', type: 'generic', count: 4, used: 1, free: 3 },
  { host: 'node-b', type: 'generic', count: 1, used: 0, free: 1 },
]

export const repos: RepoListItem[] = [
  { id: 1, fullName: 'acme/widgets', adopted: true, isPrivate: false, webhookId: 42, adoptedAt: '2026-10-19T09:30:00Z', jobCount: 2 },
  { id: 3, fullName: 'acme/polled', adopted: true, isPrivate: true, webhookId: null, adoptedAt: '2026-10-19T09:40:00Z', jobCount: 0 },
  { id: 2, fullName: 'acme/old', adopted: false, isPrivate: true, webhookId: null, adoptedAt: null, jobCount: 0 },
]

export const jobs: Job[] = [
  {
    id: 7,
    repo: 'acme/widgets',
    githubJobId: 700,
    runId: 70,
    name: 'build <main>',
    labels: ['self-hosted', 'generic'],
    status: 'in_progress',
    conclusion: null,
    runnerId: 3,
    htmlUrl: 'https://github.com/acme/widgets/actions/runs/70/job/700',
    queuedAt: '2026-10-19T10:00:00Z',
    startedAt: '2026-10-19T10:00:30Z',
    completedAt: null,
    logSource: null,
    logBytes: 120,
    logTruncated: false,
    steps: [
      { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success', startedAt: '2026-10-19T10:00:30Z', completedAt: '2026-10-19T10:00:40Z' },
      { number: 2, name: 'Build', status: 'in_progress', conclusion: null, startedAt: '2026-10-19T10:00:40Z', completedAt: null },
    ],
  },
  {
    id: 8,
    repo: 'acme/widgets',
    githubJobId: 800,
    runId: 80,
    name: 'test',
    labels: ['self-hosted', 'generic'],
    status: 'completed',
    conclusion: 'failure',
    runnerId: 2,
    htmlUrl: 'https://github.com/acme/widgets/actions/runs/80/job/800',
    queuedAt: '2026-10-19T08:00:00Z',
    startedAt: '2026-10-19T08:00:10Z',
    completedAt: '2026-10-19T08:05:10Z',
    logSource: 'github',
    logBytes: 2048,
    logTruncated: true,
    steps: [
      { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success', startedAt: '2026-10-19T08:00:10Z', completedAt: '2026-10-19T08:00:20Z' },
      { number: 2, name: 'Run tests', status: 'completed', conclusion: 'failure', startedAt: '2026-10-19T08:00:20Z', completedAt: '2026-10-19T08:05:00Z' },
      { number: 3, name: 'Complete job', status: 'completed', conclusion: 'success', startedAt: '2026-10-19T08:05:00Z', completedAt: '2026-10-19T08:05:10Z' },
    ],
  },
]

export const logs: Record<number, JobLog> = {
  7: {
    lines: [
      { seq: 1, at: '2026-10-19T10:00:31.000000000Z', line: 'Current runner version: 2.3' },
      { seq: 2, at: '2026-10-19T10:00:32.000000000Z', line: '##[group]Run <script>alert(1)</script>' },
    ],
    source: null,
    truncated: false,
    complete: false,
  },
  8: {
    lines: [{ seq: 1, at: '2026-10-19T08:00:11.1234567Z', line: 'Set up job' }],
    source: 'github',
    truncated: true,
    complete: true,
  },
}

export const runners: Runner[] = [
  { id: 3, name: 'generic-node-a-3', host: 'node-a', type: 'generic', containerId: 'abc', state: 'busy', jobId: 7, repo: 'acme/widgets', jobName: 'build <main>', createdAt: '2026-10-19T10:00:20Z', exitedAt: null },
  { id: 2, name: 'generic-node-a-2', host: 'node-a', type: 'generic', containerId: 'def', state: 'exited', jobId: 8, repo: 'acme/widgets', jobName: 'test', createdAt: '2026-10-19T08:00:05Z', exitedAt: '2026-10-19T08:05:12Z' },
]

export const images: HostImage[] = [
  { host: 'node-a', reference: 'ghcr.io/example/runner:1', digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', sizeBytes: 1_288_490_189, pulledAt: '2026-10-18T09:00:00Z', seenAt: '2026-10-19T10:00:00Z' },
  { host: 'node-a', reference: 'docker:28-dind', digest: null, sizeBytes: 400_000_000, pulledAt: null, seenAt: '2026-10-19T10:00:00Z' },
]

export const pulls: ImagePull[] = [
  { id: 1, host: 'node-b', reference: 'docker:28-dind', status: 'queued', error: null, requestedBy: 'user', createdAt: '2026-10-19T10:00:00Z', finishedAt: null },
  { id: 2, host: 'node-b', reference: 'ghcr.io/example/runner:1', status: 'failed', error: 'manifest unknown <x>', requestedBy: 'user', createdAt: '2026-10-19T09:00:00Z', finishedAt: '2026-10-19T09:01:00Z' },
]

export const references = ['docker:28-dind', 'ghcr.io/example/runner:1', 'ghcr.io/rojosinalma/octohatchery-runner:edge']

export const events: Event[] = [
  { id: 1, actor: 'user', action: 'repo.adopt', target: 'acme/widgets', detail: { webhookId: 42 }, at: '2026-10-19T09:30:00Z' },
  { id: 2, actor: 'mcp:assistant', action: 'slots.set', target: 'generic@node-a', detail: { count: 4 }, at: '2026-10-19T09:31:00Z' },
]

export const settings: Record<string, string> = {
  poll_interval_s: '300',
  stale_runner_minutes: '5',
  retention_days: '30',
  sse_max_clients: '20',
  sse_idle_s: '300',
  log_level: 'info',
  custom_flag: 'yes',
  ui_skin: 'pico',
  ui_palette: 'nord',
}

export const health: HealthSnapshot = {
  ok: true,
  mode: 'single',
  host: 'node-a',
  db: true,
  docker: true,
  leader: true,
  slots,
  queued: 0,
  runnersBusy: 1,
  lastWebhookAt: null,
  version: '0.1.0-test',
  github: { ok: true, source: 'app', missing: [] },
}

const permissionRow = (key: string, level: 'read' | 'write', granted: GitHubStatus['permissions'][number]['granted'], ok: boolean | null) => ({ key, level, why: `why ${key}`, breaks: `breaks ${key}`, granted, ok })

export const githubStatus: GitHubStatus = {
  ok: false,
  source: 'app',
  account: 'acme',
  installationId: 7654321,
  repoCount: 3,
  appSlug: 'octohatchery-acme',
  appUrl: 'https://github.com/settings/apps/octohatchery-acme',
  permissionsUrl: 'https://github.com/settings/apps/octohatchery-acme/permissions',
  installUrl: 'https://github.com/settings/installations/7654321',
  webhookUrl: 'https://hatch.example.com/webhooks/github',
  permissions: [
    permissionRow('metadata', 'read', 'read', true),
    permissionRow('administration', 'write', 'write', true),
    permissionRow('actions', 'write', 'read', false),
    permissionRow('contents', 'write', 'write', true),
    permissionRow('workflows', 'write', 'none', false),
    permissionRow('pull_requests', 'write', 'write', true),
  ],
  missing: ['actions:write', 'workflows:write'],
  checkedAt: '2026-10-20T10:00:00Z',
}

export const githubOk: GitHubStatus = { ...githubStatus, ok: true, permissions: githubStatus.permissions.map((p) => ({ ...p, granted: 'write', ok: true })), missing: [] }

/** An App installed on two accounts; the organisation lacks one permission and is not served yet. */
export const githubMulti: GitHubStatus = {
  ...githubOk,
  newInstallUrl: 'https://github.com/apps/octohatchery-acme/installations/new',
  installations: [
    { id: 7654321, account: 'acme', type: 'user', repoCount: 3, missing: [], allowed: true, url: 'https://github.com/settings/installations/7654321' },
    { id: 999, account: 'troopy-bot', type: 'org', repoCount: 1, missing: ['workflows:write'], allowed: false, url: 'https://github.com/organizations/troopy-bot/settings/installations/999' },
  ],
}

export const githubRepos: GitHubRepoItem[] = [
  { fullName: 'acme/widgets', isPrivate: false, defaultBranch: 'main', adopted: true },
  { fullName: 'acme/new-thing', isPrivate: true, defaultBranch: 'main', adopted: false },
]

export type FixtureSet = { hosts: Host[]; types: RunnerType[]; slots: Slot[]; repos: RepoListItem[]; images?: HostImage[]; pulls?: ImagePull[]; references?: string[]; githubAuth?: 'app' | 'pat' | 'none'; github?: GitHubStatus; jobs: Job[]; runners: Runner[]; events: Event[]; settings: Record<string, string>; logs: Record<number, JobLog> }

export const full: FixtureSet = { hosts, types, slots, repos, jobs, runners, events, settings, logs, images, pulls, references }
export const empty: FixtureSet = { hosts: [], types: [], slots: [], repos: [], jobs: [], runners: [], events: [], settings: {}, logs: {} }

const notFound = (message: string) => new ServiceError(message, 'not_found')

type JobsFilterLike = { repo?: string; status?: string; q?: string; since?: string; running?: boolean; failed?: boolean; runner?: string; page?: number; per?: number }
const filterJobs = (data: FixtureSet, filter?: JobsFilterLike) =>
  data.jobs.filter(
    (j) =>
      (!filter?.repo || j.repo === filter.repo) &&
      (!filter?.runner || data.runners.find((r) => r.id === j.runnerId)?.name === filter.runner) &&
      (!filter?.status || j.status === filter.status) &&
      (!filter?.q || `${j.name} ${j.repo}`.toLowerCase().includes(filter.q.toLowerCase())) &&
      (!filter?.since || j.queuedAt >= filter.since) &&
      (!filter?.running || j.status === 'claimed' || j.status === 'in_progress') &&
      (!filter?.failed || ['failure', 'timed_out', 'cancelled'].includes(j.conclusion ?? '')),
  )

/** A facade double over one fixture set; `data` can be swapped between tests. */
export const makeService = (store: { data: FixtureSet }) => ({
  listHosts: async () => store.data.hosts,
  listRunnerTypes: async () => store.data.types,
  getRunnerType: async (name: string) => store.data.types.find((t) => t.name === name)!,
  upsertRunnerType: async () => store.data.types[0]!,
  deleteRunnerType: async () => {},
  listSlots: async () => store.data.slots,
  setSlots: async () => store.data.slots[0]!,
  listRepos: async () => store.data.repos,
  githubAuthKind: () => store.data.githubAuth ?? 'pat',
  githubStatus: async () => store.data.github ?? githubOk,
  recheckGitHub: async () => store.data.github ?? githubOk,
  listGitHubRepos: async () => githubRepos,
  ensureWebhook: async () => ({ repo: store.data.repos[0]!, covered: 'hook' as const, created: true }),
  adoptRepo: async () => store.data.repos[0]!,
  unadoptRepo: async () => {},
  applyRunsOn: async () => ({ ok: true, message: 'ok' }),
  listJobs: async (filter?: JobsFilterLike) => {
    const all = filterJobs(store.data, filter)
    if (filter?.per === undefined) return all
    const page = filter.page ?? 1
    return all.slice((page - 1) * filter.per, page * filter.per)
  },
  countJobs: async (filter?: JobsFilterLike) => filterJobs(store.data, filter).length,
  listRunners: async () => store.data.runners,
  getJob: async (id: number) => {
    const job = store.data.jobs.find((j) => j.id === id)
    if (!job) throw notFound(`job ${id} is unknown`)
    return job
  },
  getJobLog: async (id: number) => store.data.logs[id] ?? { lines: [], source: null, truncated: false, complete: false },
  getRunner: async (id: number) => {
    const runner = store.data.runners.find((r) => r.id === id)
    if (!runner) throw notFound(`runner ${id} is unknown`)
    return runner
  },
  spawn: async () => store.data.runners[0]!,
  kill: async () => {},
  listImages: async () => ({ references: store.data.references ?? [], hosts: store.data.hosts, images: store.data.images ?? [], pulls: store.data.pulls ?? [] }),
  pullImage: async () => ({ ...pulls[0]!, reused: false }),
  listEvents: async () => store.data.events,
  getSettings: async () => store.data.settings,
  setSetting: async () => {},
  health: async () => health,
})

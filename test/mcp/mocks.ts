import { mock } from 'bun:test'

/** Stand-in for src/lib/types: only ServiceError is needed by the MCP layer at runtime. */
export class ServiceError extends Error {
  constructor(
    message: string,
    public code: 'not_found' | 'invalid' | 'conflict' | 'unavailable' = 'invalid',
  ) {
    super(message)
  }
}

const ok = <T>(value: T) => mock(async () => value)

/** Facade mock; every function records its calls. Reset with `resetService()` between tests. */
export const service = {
  listHosts: ok([{ id: 1, name: 'node-a', status: 'online', lastSeenAt: 't', isLeader: true, dockerOk: true }]),
  listRunnerTypes: ok([]),
  getRunnerType: ok({ name: 'generic' }),
  upsertRunnerType: mock(async (input: unknown) => ({ id: 1, ...(input as object) })),
  deleteRunnerType: ok(undefined),
  listSlots: ok([]),
  setSlots: mock(async (input: unknown) => ({ ...(input as object), used: 0, free: 1 })),
  listRepos: ok([]),
  adoptRepo: mock(async (fullName: string) => ({ id: 1, fullName, adopted: true, isPrivate: false, webhookId: 7, adoptedAt: 't' })),
  unadoptRepo: ok(undefined),
  applyRunsOn: ok({ ok: true, message: 'snippet', snippet: 'runs-on: [self-hosted, generic]' }),
  listJobs: ok([]),
  getJob: ok({ id: 1, name: 'build' }),
  getJobLog: ok({
    lines: [
      { seq: 1, at: '2026-10-20T10:00:00Z', line: 'first' },
      { seq: 2, at: '2026-10-20T10:00:01Z', line: 'second' },
    ],
    source: 'runner',
    truncated: false,
    complete: true,
  }),
  listRunners: ok([]),
  spawn: ok({ id: 9, name: 'r', host: 'node-a', type: 'generic', state: 'spawning' }),
  kill: ok(undefined),
  listEvents: ok([]),
  getSettings: ok({ poll_interval_s: '300' }),
  setSetting: ok(undefined),
  health: ok({ ok: true, mode: 'single', version: '0.1.0' }),
}

export const resetService = () => {
  for (const fn of Object.values(service)) fn.mockClear()
}

const noop = () => undefined
mock.module('../../src/lib/service', () => ({ service }))
mock.module('../../src/lib/types', () => ({ ServiceError }))
mock.module('../../src/lib/log', () => ({ log: () => ({ debug: noop, info: noop, warn: noop, error: noop }) }))

import { describe, expect, test } from 'bun:test'
import * as sqlite from '../../src/db/schema'
import * as pg from '../../src/db/schema.pg'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { drivers, driverFor } from '../../src/db/drivers'
import { backendAdapters, backendFor } from '../../src/lib/backends'
import { githubAuthAdapters, githubAuthFor } from '../../src/lib/github/auth'

describe('registries', () => {
  test('database drivers resolve by scheme', () => {
    expect(drivers.map((d) => d.schemes[0])).toEqual(['sqlite', 'postgres'])
    expect(driverFor('sqlite::memory:').schemes).toContain('sqlite')
    expect(driverFor('postgres://u:p@h/db').schemes).toContain('postgres')
    expect(driverFor('postgresql://u:p@h/db').schemes).toContain('postgresql')
    expect(() => driverFor('mysql://x')).toThrow(/No database driver/)
  })
  test('github auth adapters resolve by kind', () => {
    expect(githubAuthAdapters.map((a) => a.kind)).toEqual(['app', 'pat', 'none'])
    for (const kind of ['app', 'pat', 'none'] as const) expect(githubAuthFor(kind).kind).toBe(kind)
    expect(() => githubAuthFor('oauth')).toThrow(/Unknown GITHUB_AUTH/)
    expect(githubAuthFor('none').create().kind).toBe('none')
  })
  test('container backends resolve by kind', () => {
    expect(backendAdapters.map((b) => b.kind)).toEqual(['docker', 'fake'])
    expect(backendFor('docker').kind).toBe('docker')
    expect(backendFor('fake').create().kind).toBe('fake')
    expect(() => backendFor('podman')).toThrow(/Unknown CONTAINER_BACKEND/)
  })
})

describe('schema parity', () => {
  test('sqlite and postgres schemas declare the same tables and columns', () => {
    const shape = (mod: Record<string, unknown>) =>
      Object.fromEntries(
        Object.values(mod)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- table objects of two dialects share these helpers
          .map((t: any) => [getTableName(t), Object.values(getTableColumns(t)).map((c: any) => c.name).sort()])
          .sort(),
      )
    expect(shape(pg)).toEqual(shape(sqlite))
  })
})

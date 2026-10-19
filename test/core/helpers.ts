// Shared test bootstrap: fake GitHub, fake containers, SQLite in memory. Import this first in every core test.
import { closeDb, connectDb, type Db } from '../../src/db'
import { setBackend, backend } from '../../src/lib/backends'
import { createFakeBackend, type FakeBackend } from '../../src/lib/backends/fake'
import { loadConfig, setConfig, type Config } from '../../src/lib/config'
import { createFakeGitHub, type FakeGitHub } from '../../src/lib/github/auth/none'
import { setGitHub } from '../../src/lib/github/auth'
import { settings } from '../../src/lib/settings'
import { upsertHost } from '../../src/lib/store'

export const TEST_HOST = 'node-a'

export const TEST_ENV: Record<string, string> = {
  GITHUB_AUTH: 'none',
  CONTAINER_BACKEND: 'fake',
  DATABASE_URL: 'sqlite::memory:',
  HOST_NAME: TEST_HOST,
  MODE: 'single',
  PUBLIC_URL: 'https://hatchery.example.test',
  GITHUB_WEBHOOK_SECRET: 'test-secret',
}

export type TestWorld = { db: Db; github: FakeGitHub; docker: FakeBackend; config: Config }

/** Fresh in-memory DB, fake adapters and this host registered online. */
export async function fresh(env: Record<string, string> = {}): Promise<TestWorld> {
  await closeDb()
  settings.reset()
  const config = loadConfig({ ...TEST_ENV, ...env })
  setConfig(config)
  const github = createFakeGitHub()
  setGitHub(github)
  const docker = createFakeBackend()
  setBackend(docker)
  const db = await connectDb(config.databaseUrl)
  await upsertHost({ name: config.hostName, isLeader: true, dockerOk: true })
  await settings.set('log_level', Bun.env.TEST_LOG_LEVEL ?? 'error')
  return { db, github, docker, config }
}

export { backend }

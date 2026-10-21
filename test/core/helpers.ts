// Shared test bootstrap: fake GitHub, fake containers, SQLite in memory. Import this first in every core test.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, connectDb, type Db } from '../../src/db'
import { setBackend, backend } from '../../src/lib/backends'
import { createFakeBackend, type FakeBackend } from '../../src/lib/backends/fake'
import { loadConfig, setConfig, type Config } from '../../src/lib/config'
import { createFakeGitHub, type FakeGitHub } from '../../src/lib/github/auth/none'
import { setGitHub } from '../../src/lib/github/auth'
import { resetGitHubCredential } from '../../src/lib/github/credential'
import { resetImagePulls } from '../../src/lib/images'
import { configureJobLog } from '../../src/lib/joblog'
import { resetGitHubCaches } from '../../src/lib/service'
import { settings } from '../../src/lib/settings'
import { upsertHost } from '../../src/lib/store'
import { resetReconciled } from '../../src/lib/sweep'

export const TEST_HOST = 'node-a'

// Tests never touch the real DATA_DIR: bin/verify runs them inside a live container, where ./data holds the
// adopted database file.
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'octohatchery-test-'))
process.on('exit', () => rmSync(TEST_DATA_DIR, { recursive: true, force: true }))

export const TEST_ENV: Record<string, string> = {
  DATA_DIR: TEST_DATA_DIR,
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
  resetGitHubCaches()
  resetImagePulls()
  resetReconciled()
  configureJobLog({ retryDelaysMs: [], flushMs: 10 })
  const config = loadConfig({ ...TEST_ENV, ...env })
  setConfig(config)
  resetGitHubCredential()
  const github = createFakeGitHub()
  setGitHub(github)
  const docker = createFakeBackend()
  setBackend(docker)
  const db = await connectDb(config.databaseUrl, { schema: config.databaseSchema })
  await upsertHost({ name: config.hostName, isLeader: true, dockerOk: true })
  await settings.set('log_level', Bun.env.TEST_LOG_LEVEL ?? 'error')
  return { db, github, docker, config }
}

export { backend }

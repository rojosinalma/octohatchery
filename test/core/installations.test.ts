import { describe, expect, test } from 'bun:test'
import { sign } from '@octokit/webhooks-methods'
import { Elysia } from 'elysia'
import { fresh, TEST_HOST } from './helpers'
import { accountPolicy, allows, notServedReason, parseAccounts } from '../../src/lib/github/accounts'
import { installationIndex, type Installation } from '../../src/lib/github/installations'
import { claim } from '../../src/lib/scheduler'
import { service } from '../../src/lib/service'
import { settings } from '../../src/lib/settings'
import { pollQueuedJobs } from '../../src/lib/sweep'
import { webhooks } from '../../src/routes/webhooks'

const ALL_GRANTED = { metadata: 'read', administration: 'write', actions: 'write', contents: 'write', workflows: 'write', pull_requests: 'write' }
const ROJO: Installation = { id: 11, account: 'rojo', accountType: 'User', permissions: { ...ALL_GRANTED } }
const TROOPY: Installation = { id: 22, account: 'troopy-bot', accountType: 'Organization', permissions: { ...ALL_GRANTED, workflows: 'read' } }

function payload(repo: string, id: number, installation?: number) {
  return JSON.stringify({
    action: 'queued',
    workflow_job: { id, run_id: 5, name: 'build', labels: ['self-hosted', 'generic'], status: 'queued', html_url: 'https://github.test/j' },
    repository: { full_name: repo },
    ...(installation ? { installation: { id: installation } } : {}),
  })
}

async function deliver(body: string) {
  const app = new Elysia().use(webhooks)
  const res = await app.handle(
    new Request('http://local/webhooks/github', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'workflow_job', 'x-hub-signature-256': await sign('test-secret', body) },
      body,
    }),
  )
  return { status: res.status, json: (await res.json()) as { ok: boolean; message: string } }
}

/** Fresh world whose fake GitHub is an App installed on `rojo` (default) and `troopy-bot`. */
async function multi(opts: { defaultId?: number } = { defaultId: ROJO.id }) {
  const w = await fresh()
  w.github.useInstallations([ROJO, TROOPY], opts)
  w.github.kind = 'app'
  w.github.reposByInstallation.set(ROJO.id, [{ fullName: 'rojo/site', isPrivate: true, defaultBranch: 'main' }])
  w.github.reposByInstallation.set(TROOPY.id, [
    { fullName: 'troopy-bot/troopy', isPrivate: true, defaultBranch: 'dev' },
    { fullName: 'troopy-bot/docs', isPrivate: false, defaultBranch: 'main' },
  ])
  return w
}

describe('installation index', () => {
  test('caches the list for the TTL; a refresh or invalidate asks again', async () => {
    let t = 0
    let fetches = 0
    const idx = installationIndex(async () => (fetches++, [ROJO]), { ttlMs: 1000, missRefetchMs: 100, now: () => t })
    await idx.list()
    await idx.list()
    expect(fetches).toBe(1)
    t = 999
    await idx.list()
    expect(fetches).toBe(1)
    t = 1001
    await idx.list()
    expect(fetches).toBe(2)
    await idx.list({ refresh: true })
    expect(fetches).toBe(3)
    idx.invalidate()
    await idx.list()
    expect(fetches).toBe(4)
  })

  test('resolves an owner case-insensitively; a miss refetches, at most once per miss window', async () => {
    let t = 0
    const list = [ROJO]
    let fetches = 0
    const idx = installationIndex(async () => (fetches++, [...list]), { ttlMs: 60_000, missRefetchMs: 100, now: () => t })
    expect((await idx.forOwner('ROJO'))?.id).toBe(11)
    list.push(TROOPY) // installed on a new account after the list was cached
    expect(await idx.forOwner('troopy-bot')).toBeUndefined() // the list is younger than the miss window
    expect(fetches).toBe(1)
    t = 150
    expect((await idx.forOwner('troopy-bot'))?.id).toBe(22)
    expect(fetches).toBe(2)
    expect(await idx.forOwner('nobody')).toBeUndefined() // just fetched: no second call
    expect(fetches).toBe(2)
  })

  test('a failed refresh serves the older list; with nothing cached it throws', async () => {
    let t = 0
    let fail = false
    const idx = installationIndex(
      async () => {
        if (fail) throw new Error('502 Bad Gateway')
        return [ROJO]
      },
      { ttlMs: 10, now: () => t },
    )
    await idx.list()
    fail = true
    t = 50
    expect((await idx.list()).map((i) => i.id)).toEqual([11])
    await expect(idx.list({ refresh: true })).rejects.toThrow('502')
    idx.invalidate()
    await expect(idx.list()).rejects.toThrow('502')
  })

  test('every repo call uses the installation of the repo owner', async () => {
    const w = await multi({})
    await settings.set('github_accounts', 'rojo,troopy-bot')
    await service.adoptRepo('troopy-bot/troopy', 'user')
    await service.adoptRepo('rojo/site', 'user')
    await service.setSlots({ host: TEST_HOST, type: 'generic', count: 2 }, 'user')
    expect((await deliver(payload('troopy-bot/troopy', 1, TROOPY.id))).json.message).toBe('job queued')
    expect((await deliver(payload('rojo/site', 2, ROJO.id))).json.message).toBe('job queued')
    await claim()
    expect(w.github.installationCalls).toContain('createJitConfig troopy-bot/troopy → 22')
    expect(w.github.installationCalls).toContain('createJitConfig rojo/site → 11')
    expect(w.github.installationCalls).toContain('getRepo troopy-bot/troopy → 22')
    await w.github.getJob('troopy-bot/troopy', 1)
    expect(w.github.installationCalls).toContain('getJob troopy-bot/troopy → 22')
    await expect(w.github.getJob('stranger/x', 1)).rejects.toMatchObject({ status: 404, message: expect.stringContaining('not installed on stranger') })
  })
})

describe('github_accounts allowlist', () => {
  test('policy: listed accounts, else the default installation, else every installation', async () => {
    await fresh()
    expect(parseAccounts(' Rojo, troopy-bot,,rojo ')).toEqual(['rojo', 'troopy-bot'])
    expect(await accountPolicy(undefined)).toEqual({ kind: 'all' })
    expect(await accountPolicy(11)).toEqual({ kind: 'default', installationId: 11 })
    await settings.set('github_accounts', 'Troopy-Bot')
    const listed = await accountPolicy(11)
    expect(listed).toEqual({ kind: 'listed', accounts: ['troopy-bot'] })
    expect(allows(listed, TROOPY)).toBe(true)
    expect(allows(listed, ROJO)).toBe(false)
    expect(allows({ kind: 'default', installationId: 11 }, ROJO)).toBe(true)
    expect(allows({ kind: 'default', installationId: 11 }, TROOPY)).toBe(false)
  })

  test('a webhook from an installation that is not served is dropped: an event, never a job row', async () => {
    const w = await multi()
    // Adopted while it was served, then the account is unticked: still no job row.
    await settings.set('github_accounts', 'rojo,troopy-bot')
    await service.adoptRepo('troopy-bot/troopy', 'user')
    await service.setSetting('github_accounts', 'rojo', 'user')
    const r = await deliver(payload('troopy-bot/troopy', 7, TROOPY.id))
    expect(r.status).toBe(200)
    expect(r.json.message).toMatch(/^ignored: account troopy-bot is not in github_accounts/)
    expect(await service.listJobs()).toHaveLength(0)
    const ev = (await service.listEvents()).find((e) => e.action === 'webhook.ignored')
    expect(ev).toMatchObject({ actor: 'github', target: 'troopy-bot/troopy' })
    // Default policy (setting empty, GITHUB_APP_INSTALLATION_ID = rojo): decided by the delivery's installation id.
    await service.setSetting('github_accounts', '', 'user')
    const calls = w.github.installationFetches()
    expect((await deliver(payload('troopy-bot/troopy', 8, TROOPY.id))).json.message).toMatch(/not the default installation/)
    expect(w.github.installationFetches()).toBe(calls) // no GitHub call needed
    expect(await service.listJobs()).toHaveLength(0)
    // The poll fallback skips the repo as well.
    w.github.queued.set('troopy-bot/troopy', [{ githubJobId: 9, runId: 1, name: 'b', labels: ['self-hosted'], htmlUrl: '', queuedAt: '2026-01-01T00:00:00Z' }])
    expect(await pollQueuedJobs()).toBe(0)
    expect(w.github.calls.some((c) => c.method === 'listQueuedJobs')).toBe(false)
  })

  test('adopt refuses an account that is not served or where the App is not installed', async () => {
    await multi()
    await expect(service.adoptRepo('troopy-bot/troopy', 'user')).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('troopy-bot/troopy is not served: account troopy-bot is not the default installation') })
    await expect(service.adoptRepo('stranger/x', 'user')).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('not installed on stranger') })
    expect((await service.adoptRepo('rojo/site', 'user')).fullName).toBe('rojo/site')
    await service.setSetting('github_accounts', 'rojo,troopy-bot', 'user')
    expect((await service.adoptRepo('troopy-bot/troopy', 'user')).adopted).toBe(true)
    expect(await notServedReason(undefined, 'anyone')).toBeNull() // sources without installations serve their one account
  })

  test('setting validation: logins only, normalised', async () => {
    await fresh()
    await expect(service.setSetting('github_accounts', 'rojo,not a login', 'user')).rejects.toMatchObject({ message: expect.stringContaining('"not a login" is not a GitHub login') })
    await service.setSetting('github_accounts', ' Rojo ,troopy-bot,rojo', 'user')
    expect(await settings.fetch('github_accounts', '')).toBe('rojo,troopy-bot')
  })
})

describe('status and repository list across installations', () => {
  test('status: one row per installation, default on top, gaps of served installations only', async () => {
    await multi()
    const s = await service.recheckGitHub('user')
    expect(s.installationId).toBe(11)
    expect(s.account).toBe('rojo')
    expect(s.installUrl).toBe('https://github.com/settings/installations/11')
    expect(s.installations).toEqual([
      { id: 11, account: 'rojo', type: 'user', repoCount: 1, missing: [], allowed: true, url: 'https://github.com/settings/installations/11' },
      { id: 22, account: 'troopy-bot', type: 'org', repoCount: 2, missing: ['workflows:write'], allowed: false, url: 'https://github.com/organizations/troopy-bot/settings/installations/22' },
    ])
    expect(s.missing).toEqual([]) // troopy-bot is not served, so its gap does not count
    expect(s.ok).toBe(true)
    await service.setSetting('github_accounts', 'rojo,troopy-bot', 'user')
    const s2 = await service.githubStatus() // the setting dropped the cached status
    expect(s2.installations!.map((i) => i.allowed)).toEqual([true, true])
    expect(s2.missing).toEqual(['workflows:write'])
    expect(s2.ok).toBe(false)
    // apply_runs_on checks the installation of the repo's owner
    await service.adoptRepo('troopy-bot/troopy', 'user')
    await expect(service.applyRunsOn({ fullName: 'troopy-bot/troopy', mode: 'commit', type: 'generic' }, 'user')).rejects.toMatchObject({
      message: expect.stringContaining('GitHub access on troopy-bot lacks workflows:write'),
    })
  })

  test('without GITHUB_APP_INSTALLATION_ID every installation is served and the first is the default', async () => {
    await multi({})
    const s = await service.githubStatus()
    expect(s.installations!.every((i) => i.allowed)).toBe(true)
    expect(s.installationId).toBe(11)
    expect(s.missing).toEqual(['workflows:write'])
  })

  test('repository list covers every served installation; recheck re-fetches the installations', async () => {
    const w = await multi()
    expect((await service.listGitHubRepos()).map((r) => r.fullName)).toEqual(['rojo/site'])
    await service.setSetting('github_accounts', 'rojo,troopy-bot', 'user')
    expect((await service.listGitHubRepos()).map((r) => r.fullName)).toEqual(['rojo/site', 'troopy-bot/docs', 'troopy-bot/troopy'])
    const before = w.github.installationFetches()
    await service.recheckGitHub('user')
    expect(w.github.installationFetches()).toBe(before + 1)
  })
})

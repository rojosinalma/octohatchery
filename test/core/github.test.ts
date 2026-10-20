import { describe, expect, test } from 'bun:test'
import { fresh } from './helpers'
import { buildStatus, covers, evaluate, githubLinks, grantedLevel, REQUIRED_PERMISSIONS, RUNS_ON_PERMISSIONS, unknownStatus } from '../../src/lib/github/permissions'
import { githubMessage, paginateUpTo } from '../../src/lib/github/rest'
import { service } from '../../src/lib/service'

const WORKFLOW = 'jobs:\n  build:\n    runs-on: ubuntu-latest\n'

describe('permissions model', () => {
  test('required list covers what the code calls; runs-on modes name a subset', () => {
    const keys = REQUIRED_PERMISSIONS.map((p) => p.key)
    expect(keys).toEqual(['metadata', 'administration', 'actions', 'contents', 'workflows', 'pull_requests', 'webhooks'])
    for (const p of REQUIRED_PERMISSIONS) {
      expect(p.why.length).toBeGreaterThan(10)
      expect(p.breaks.length).toBeGreaterThan(10)
    }
    for (const needed of Object.values(RUNS_ON_PERMISSIONS)) for (const k of needed) expect(keys).toContain(k)
    expect(RUNS_ON_PERMISSIONS.pr).toContain('pull_requests')
    expect(RUNS_ON_PERMISSIONS.commit).not.toContain('pull_requests')
  })

  test('granted levels: admin counts as write, missing as none, unknown stays unknown', () => {
    const g = { a: 'admin', w: 'write', r: 'read', u: 'unknown' }
    expect(grantedLevel(g, 'a')).toBe('write')
    expect(grantedLevel(g, 'w')).toBe('write')
    expect(grantedLevel(g, 'r')).toBe('read')
    expect(grantedLevel(g, 'u')).toBe('unknown')
    expect(grantedLevel(g, 'missing')).toBe('none')
    expect(covers('write', 'read')).toBe(true)
    expect(covers('read', 'write')).toBe(false)
    expect(covers('none', 'read')).toBe(false)
    expect(covers('unknown', 'write')).toBeNull()
  })

  test('evaluate: definite gaps only; webhooks required for pat only; app links for user and organisation', () => {
    const app = evaluate({ source: 'app', granted: { metadata: 'read', administration: 'write', actions: 'read', contents: 'write', pull_requests: 'write' } })
    expect(app.missing).toEqual(['actions:write', 'workflows:write'])
    expect(app.permissions.map((p) => p.key)).not.toContain('webhooks')
    const pat = evaluate({ source: 'pat', granted: { metadata: 'read', administration: 'unknown', actions: 'unknown', contents: 'unknown', workflows: 'unknown', pull_requests: 'unknown', webhooks: 'none' } })
    expect(pat.missing).toEqual(['webhooks:write'])
    expect(pat.permissions.find((p) => p.key === 'actions')!.ok).toBeNull()
    const none = evaluate({ source: 'none', granted: {} })
    expect(none.missing).toEqual([])
    expect(none.permissions.every((p) => p.granted === 'unknown')).toBe(true)

    expect(githubLinks({ source: 'app', granted: {}, appSlug: 'hatch', installationId: 5, appOwner: { login: 'me', type: 'User' }, account: 'me', accountType: 'User' })).toEqual({
      appUrl: 'https://github.com/settings/apps/hatch',
      permissionsUrl: 'https://github.com/settings/apps/hatch/permissions',
      installUrl: 'https://github.com/settings/installations/5',
    })
    expect(githubLinks({ source: 'app', granted: {}, appSlug: 'hatch', installationId: 5, appOwner: { login: 'acme', type: 'Organization' }, account: 'acme', accountType: 'Organization' })).toEqual({
      appUrl: 'https://github.com/organizations/acme/settings/apps/hatch',
      permissionsUrl: 'https://github.com/organizations/acme/settings/apps/hatch/permissions',
      installUrl: 'https://github.com/organizations/acme/settings/installations/5',
    })
    expect(githubLinks({ source: 'pat', granted: {} }).permissionsUrl).toContain('personal-access-tokens')
  })

  test('buildStatus and unknownStatus', () => {
    const ok = buildStatus({ source: 'app', granted: Object.fromEntries(REQUIRED_PERMISSIONS.map((p) => [p.key, 'write'])) }, 'https://x/webhooks/github')
    expect(ok.ok).toBe(true)
    expect(ok.missing).toEqual([])
    expect(ok.webhookUrl).toBe('https://x/webhooks/github')
    const down = unknownStatus('app', 'ETIMEDOUT', undefined)
    expect(down.ok).toBe(false)
    expect(down.error).toBe('ETIMEDOUT')
    expect(down.missing).toEqual([])
    expect(down.permissions.every((p) => p.ok === null)).toBe(true)
  })

  test('helpers: GitHub message keeps the status, pagination stops at the cap', async () => {
    expect(githubMessage(Object.assign(new Error('Resource not accessible by integration - https://docs.github.com/rest'), { status: 403 }))).toBe('Resource not accessible by integration (HTTP 403)')
    expect(githubMessage(new Error('boom'))).toBe('boom')
    async function* pages() {
      for (let i = 0; i < 10; i++) yield { data: [i * 2, i * 2 + 1] }
    }
    expect(await paginateUpTo(pages(), 5)).toEqual([0, 1, 2, 3, 4])
  })
})

describe('service.githubStatus', () => {
  test('none source: not ok, nothing missing, cached, recheck records an event', async () => {
    const w = await fresh()
    const s1 = await service.githubStatus()
    expect(s1).toMatchObject({ ok: false, source: 'none', missing: [], webhookUrl: 'https://hatchery.example.test/webhooks/github' })
    const s2 = await service.githubStatus()
    expect(s2.checkedAt).toBe(s1.checkedAt)
    await new Promise((r) => setTimeout(r, 2))
    const s3 = await service.recheckGitHub('user')
    expect(s3.checkedAt).not.toBe(s1.checkedAt)
    expect((await service.listEvents()).some((e) => e.action === 'github.recheck')).toBe(true)
    const h = await service.health()
    expect(h.github).toEqual({ ok: false, source: 'none', missing: [] })
    expect(h.ok).toBe(true)
    expect(w.github.calls.filter((c) => c.method === 'permissions').length).toBe(0) // none never asks
  })

  test('listGitHubRepos refuses with GITHUB_AUTH=none', async () => {
    await fresh()
    await expect(service.listGitHubRepos()).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('GITHUB_AUTH=none') })
  })
})

describe('applyRunsOn hardening', () => {
  test('pre-check names the missing permissions and the page to fix them; nothing is written', async () => {
    const w = await fresh()
    await service.adoptRepo('acme/app', 'user')
    w.github.files.set('acme/app:.github/workflows/ci.yml', WORKFLOW)
    Object.assign(w.github.granted, { metadata: 'read', contents: 'write', workflows: 'none', pull_requests: 'none' })
    w.github.kind = 'app'
    const err = await service.applyRunsOn({ fullName: 'acme/app', mode: 'pr', type: 'generic' }, 'user').catch((e) => e)
    expect(err).toMatchObject({ code: 'invalid' })
    expect(err.message).toContain('workflows:write, pull_requests:write')
    expect(err.message).toContain('a pull request')
    expect(w.github.calls.some((c) => c.method === 'createBranch' || c.method === 'putFile')).toBe(false)
    // commit mode does not need pull_requests
    await service.recheckGitHub('user')
    Object.assign(w.github.granted, { workflows: 'write' })
    await service.recheckGitHub('user')
    const out = await service.applyRunsOn({ fullName: 'acme/app', mode: 'commit', type: 'generic' }, 'user')
    expect(out.ok).toBe(true)
    expect(out.commitSha).toBe('fake-commit')
    expect(out.htmlUrl).toContain('/commit/')
  })

  test('pr mode: branch removed when a write fails, GitHub message kept; PR verified on success', async () => {
    const w = await fresh()
    await service.adoptRepo('acme/app', 'user')
    w.github.files.set('acme/app:.github/workflows/ci.yml', WORKFLOW)
    w.github.failOn.set('putFile', 'Resource not accessible by integration')
    const err = await service.applyRunsOn({ fullName: 'acme/app', mode: 'pr', type: 'generic' }, 'user').catch((e) => e)
    expect(err).toMatchObject({ code: 'unavailable' })
    expect(err.message).toContain('Resource not accessible by integration (HTTP 403)')
    expect(w.github.calls.some((c) => c.method === 'deleteBranch')).toBe(true)
    expect(w.github.branches.size).toBe(0)

    w.github.failOn.clear()
    w.github.calls.length = 0
    const pr = await service.applyRunsOn({ fullName: 'acme/app', mode: 'pr', type: 'generic' }, 'user')
    expect(pr.ok).toBe(true)
    expect(pr.prUrl).toContain('/pull/1')
    expect(pr.message).toContain('Pull request #1')
    expect(w.github.calls.some((c) => c.method === 'getPullRequest')).toBe(true)
    expect(w.github.branches.size).toBe(1)
  })

  test('pr mode: a branch with nothing to change is removed again', async () => {
    const w = await fresh()
    await service.adoptRepo('acme/app', 'user')
    w.github.files.set('acme/app:.github/workflows/mac.yml', 'jobs:\n  m:\n    runs-on: macos-14\n')
    const out = await service.applyRunsOn({ fullName: 'acme/app', mode: 'pr', type: 'generic' }, 'user')
    expect(out.ok).toBe(false)
    expect(w.github.branches.size).toBe(0)
  })
})

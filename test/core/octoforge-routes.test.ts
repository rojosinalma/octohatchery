import { afterEach, describe, expect, test } from 'bun:test'
import { sign } from '@octokit/webhooks-methods'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { Elysia } from 'elysia'
import { fresh } from './helpers'
import manifestFile from '../../octoforge.json'
import appManifest from '../../docs/github-app-manifest.json'
import { ConfigError, config, loadConfig } from '../../src/lib/config'
import { github, setGitHub } from '../../src/lib/github/auth'
import { githubCredential } from '../../src/lib/github/credential'
import { refreshGitHubCredential, setGitHubVerifier } from '../../src/lib/octoforge/github'
import { settings } from '../../src/lib/settings'
import { api } from '../../src/routes/api'
import { health } from '../../src/routes/health'
import { octoforge, bearerMatches } from '../../src/routes/octoforge'
import { webhooks } from '../../src/routes/webhooks'
import { db } from '../../src/db'
import { sql } from 'drizzle-orm'

const TOKEN = 'forge-token-0123456789'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const PAT = 'ghp_delivered_token_value'
const APP_SECRET = 'delivered-webhook-secret'
const PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

function app() {
  return new Elysia().use(api).use(octoforge).use(health).use(webhooks)
}

/** Every response text a test saw, checked for secrets at the end of each test. */
let seen: string[] = []

async function call(a: ReturnType<typeof app>, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await a.handle(
    new Request(`http://local${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }),
  )
  const text = await res.text()
  seen.push(text)
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text)
  } catch {
    // non-JSON
  }
  return { status: res.status, json, text }
}

const fakeVerifier = {
  calls: [] as string[],
  async pat(token: string) {
    fakeVerifier.calls.push(`pat`)
    if (token !== PAT) throw Object.assign(new Error('Bad credentials'), { status: 401 })
    return { login: 'octocat' }
  },
  async app(appId: string) {
    fakeVerifier.calls.push(`app ${appId}`)
    if (appId === '500') throw Object.assign(new Error('Server Error'), { status: 500 })
    if (appId !== '42') throw Object.assign(new Error('Integration not found'), { status: 404 })
    return { appSlug: 'hatchery-test' }
  },
}

async function world(env: Record<string, string> = {}) {
  const w = await fresh({ OCTOFORGE_TOKEN: TOKEN, ...env })
  seen = []
  fakeVerifier.calls = []
  setGitHubVerifier(fakeVerifier)
  return w
}

afterEach(() => {
  setGitHubVerifier(undefined)
  for (const text of seen) for (const secret of [PAT, APP_SECRET, PRIVATE_KEY.split('\n')[1]!, TOKEN]) expect(text).not.toContain(secret)
  seen = []
})

describe('octoforge.json', () => {
  test('asks for exactly what the App manifest asks for', () => {
    expect(manifestFile.contract).toBe(1)
    expect(manifestFile.name).toBe('octohatchery')
    expect(manifestFile.github.app.permissions).toEqual(appManifest.default_permissions)
    expect(manifestFile.github.pat.fine_grained).toEqual(appManifest.default_permissions)
    expect(manifestFile.github.app.events).toEqual(appManifest.default_events)
    expect(appManifest.hook_attributes.url.endsWith(manifestFile.github.app.webhook_path)).toBe(true)
  })
})

describe('bearer', () => {
  test('matches only the exact token', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false)
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false)
    expect(bearerMatches(undefined, TOKEN)).toBe(false)
    expect(bearerMatches('Bearer ', TOKEN)).toBe(false)
  })
})

describe('octoforge routes', () => {
  test('without OCTOFORGE_TOKEN every route answers 404', async () => {
    await fresh()
    seen = []
    const a = app()
    for (const [method, path] of [
      ['GET', '/api/octoforge/manifest'],
      ['GET', '/api/octoforge/status'],
      ['PUT', '/api/octoforge/github'],
      ['DELETE', '/api/octoforge/github'],
      ['POST', '/api/octoforge/database/adopt'],
      ['DELETE', '/api/octoforge/database'],
      ['PUT', '/api/octoforge/siblings'],
      ['DELETE', '/api/octoforge/siblings'],
      ['GET', '/api/octoforge/nothing'],
    ] as const) {
      const r = await call(a, method, path, method === 'PUT' ? { mode: 'pat', token: PAT } : undefined, AUTH)
      expect(r.status).toBe(404)
    }
    expect((await call(a, 'GET', '/health')).status).toBe(200)
  })

  test('manifest needs no bearer; everything else answers 401 without the right one', async () => {
    await world()
    const a = app()
    const m = await call(a, 'GET', '/api/octoforge/manifest')
    expect(m.status).toBe(200)
    expect(m.json).toEqual(manifestFile as unknown as Record<string, unknown>)
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: TOKEN }] as Record<string, string>[]) {
      const r = await call(a, 'GET', '/api/octoforge/status', undefined, headers)
      expect(r.status).toBe(401)
      expect(r.json).toMatchObject({ ok: false, code: 'unauthorized' })
      // Refused before the body is read: an invalid body still gets 401, not a validation error.
      expect((await call(a, 'PUT', '/api/octoforge/github', { mode: 'bogus' }, headers)).status).toBe(401)
    }
  })

  test('status: contract, version, github and database, no secrets', async () => {
    await world()
    const r = await call(app(), 'GET', '/api/octoforge/status', undefined, AUTH)
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, contract: 1, github: { mode: 'none', source: 'none' } })
    expect(typeof r.json.version).toBe('string')
    expect(r.json.database).toMatchObject({ engine: 'sqlite' })
    expect(r.json.public_url).toBe('https://hatchery.example.test')
  })

  test('status: public_url is left out when PUBLIC_URL is unset', async () => {
    await world({ PUBLIC_URL: '' })
    const r = await call(app(), 'GET', '/api/octoforge/status', undefined, AUTH)
    expect(r.status).toBe(200)
    expect('public_url' in r.json).toBe(false)
  })

  test('PUT /github with a token: checked, stored, in use, client rebuilt; DELETE goes back to env', async () => {
    const w = await world()
    const a = app()
    const r = await call(a, 'PUT', '/api/octoforge/github', { mode: 'pat', token: PAT }, AUTH)
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, login: 'octocat', restart_required: false })
    expect(fakeVerifier.calls).toEqual(['pat'])
    expect(github()).not.toBe(w.github)
    expect(github().kind).toBe('pat')
    expect(JSON.parse(await settings.fetch('octoforge_github', '{}'))).toMatchObject({ mode: 'pat', token: PAT, login: 'octocat' })
    // The env has a webhook secret: it stays the one used for repo webhooks; nothing is generated.
    expect(githubCredential().webhookSecret).toBe('test-secret')
    expect(await settings.fetch('octoforge_webhook_secret', '')).toBe('')
    let s = await call(a, 'GET', '/api/octoforge/status', undefined, AUTH)
    expect(s.json.github).toEqual({ mode: 'pat', source: 'octoforge', login: 'octocat' })
    // The dashboard's GitHub status names the source (fake client again so no request leaves the test).
    setGitHub(w.github)
    expect(((await call(a, 'GET', '/api/github/status')).json.status as { credentialSource: string }).credentialSource).toBe('octoforge')
    const events = (await call(a, 'GET', '/api/events')).json.events as { actor: string; action: string }[]
    expect(events[0]).toMatchObject({ actor: 'octoforge', action: 'github.delivered' })

    const d = await call(a, 'DELETE', '/api/octoforge/github', undefined, AUTH)
    expect(d.json).toMatchObject({ ok: true, removed: true, restart_required: false })
    s = await call(a, 'GET', '/api/octoforge/status', undefined, AUTH)
    expect(s.json.github).toEqual({ mode: 'none', source: 'none' })
    expect(github().kind).toBe('none')
    expect(await settings.fetch('octoforge_github', '')).toBe('')
    expect(((await call(a, 'GET', '/api/events')).json.events as { action: string }[])[0]!.action).toBe('github.dropped')
  })

  test('a refused credential stores nothing; GitHub down answers 502; bad input 400', async () => {
    const w = await world()
    const a = app()
    let r = await call(a, 'PUT', '/api/octoforge/github', { mode: 'pat', token: 'ghp_wrong' }, AUTH)
    expect(r.status).toBe(400)
    expect(r.json).toMatchObject({ ok: false, code: 'invalid' })
    expect(r.json.message).toContain('Bad credentials')
    r = await call(a, 'PUT', '/api/octoforge/github', { mode: 'app', app_id: 500, private_key: PRIVATE_KEY, webhook_secret: APP_SECRET }, AUTH)
    expect(r.status).toBe(502)
    expect(r.json.ok).toBe(false)
    r = await call(a, 'PUT', '/api/octoforge/github', { mode: 'app', app_id: 42, private_key: 'not a key', webhook_secret: APP_SECRET }, AUTH)
    expect(r.status).toBe(400)
    r = await call(a, 'PUT', '/api/octoforge/github', { mode: 'app', app_id: 'abc', private_key: PRIVATE_KEY, webhook_secret: APP_SECRET }, AUTH)
    expect(r.status).toBe(400)
    expect(await settings.fetch('octoforge_github', '')).toBe('')
    expect(github()).toBe(w.github)
    expect(githubCredential().source).toBe('none')
  })

  test('PUT /github with an App: delivered webhook secret verifies webhooks, the env one no longer does', async () => {
    await world()
    const a = app()
    const r = await call(a, 'PUT', '/api/octoforge/github', { mode: 'app', app_id: 42, private_key: PRIVATE_KEY.replace(/\n/g, '\\n'), webhook_secret: APP_SECRET, installation_id: '7' }, AUTH)
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, app_slug: 'hatchery-test', restart_required: false })
    expect(github().kind).toBe('app')
    expect(githubCredential()).toMatchObject({ mode: 'app', source: 'octoforge', appId: '42', installationId: '7', privateKey: PRIVATE_KEY })
    const s = await call(a, 'GET', '/api/octoforge/status', undefined, AUTH)
    expect(s.json.github).toEqual({ mode: 'app', source: 'octoforge', app_id: 42 })

    const body = JSON.stringify({ zen: 'hi' })
    const ping = (signature: string) =>
      a.handle(new Request('http://local/webhooks/github', { method: 'POST', headers: { 'x-github-event': 'ping', 'x-hub-signature-256': signature }, body }))
    expect((await ping(await sign(APP_SECRET, body))).status).toBe(200)
    expect((await ping(await sign('test-secret', body))).status).toBe(401)
  })

  test('delivered wins over env; DELETE falls back to the env credential', async () => {
    await world({ GITHUB_AUTH: 'pat', GITHUB_TOKEN: 'ghp_env_token' })
    setGitHub(undefined)
    const a = app()
    expect(githubCredential()).toMatchObject({ mode: 'pat', source: 'env', token: 'ghp_env_token' })
    let s = await call(a, 'GET', '/api/octoforge/status', undefined, AUTH)
    expect(s.json.github).toEqual({ mode: 'pat', source: 'env' })
    await call(a, 'PUT', '/api/octoforge/github', { mode: 'pat', token: PAT }, AUTH)
    expect(githubCredential()).toMatchObject({ source: 'octoforge', token: PAT })
    await call(a, 'DELETE', '/api/octoforge/github', undefined, AUTH)
    expect(githubCredential()).toMatchObject({ mode: 'pat', source: 'env', token: 'ghp_env_token' })
    s = await call(a, 'GET', '/api/octoforge/status', undefined, AUTH)
    expect(s.json.github).toEqual({ mode: 'pat', source: 'env' })
  })

  test('a token without an env webhook secret gets a generated one, kept across deliveries', async () => {
    await world({ GITHUB_WEBHOOK_SECRET: '' })
    const a = app()
    await call(a, 'PUT', '/api/octoforge/github', { mode: 'pat', token: PAT }, AUTH)
    const generated = await settings.fetch('octoforge_webhook_secret', '')
    expect(generated).toMatch(/^[0-9a-f]{64}$/)
    expect(githubCredential().webhookSecret).toBe(generated)
    await call(a, 'DELETE', '/api/octoforge/github', undefined, AUTH)
    await call(a, 'PUT', '/api/octoforge/github', { mode: 'pat', token: PAT }, AUTH)
    expect(githubCredential().webhookSecret).toBe(generated)
    // Repo webhooks are created with it (fake client: nothing leaves the test).
    const fake = (await import('../../src/lib/github/auth/none')).createFakeGitHub()
    setGitHub(fake)
    expect((await call(a, 'POST', '/api/repos/adopt', { fullName: 'acme/app' })).status).toBe(200)
    expect(fake.calls.find((c) => c.method === 'ensureWebhook')?.args[2]).toBe(generated)
  })

  test('settings API hides octoforge_ keys and refuses to set them', async () => {
    await world()
    const a = app()
    await call(a, 'PUT', '/api/octoforge/github', { mode: 'pat', token: PAT }, AUTH)
    await settings.set('octoforge_webhook_secret', 'x'.repeat(64))
    const all = (await call(a, 'GET', '/api/settings')).json.settings as Record<string, string>
    expect(Object.keys(all).filter((k) => k.startsWith('octoforge_'))).toEqual([])
    const r = await call(a, 'PUT', '/api/settings/octoforge_github', { value: '{}' })
    expect(r.status).toBe(400)
    expect(r.json).toMatchObject({ ok: false, code: 'invalid' })
    expect(JSON.parse(await settings.fetch('octoforge_github', '{}')).token).toBe(PAT)
  })

  test('another node picks up a delivery and a drop from the shared settings table', async () => {
    const w = await world()
    expect(await refreshGitHubCredential()).toBe(false)
    // Another node stored a delivery: this node sees it once its settings cache expires.
    await db().run(sql`insert into settings (key, value, updated_at) values ('octoforge_github', ${JSON.stringify({ mode: 'pat', token: PAT, login: 'octocat', delivered_at: new Date().toISOString() })}, ${new Date().toISOString()})`)
    settings.reset()
    expect(await refreshGitHubCredential()).toBe(true)
    expect(githubCredential()).toMatchObject({ mode: 'pat', source: 'octoforge', login: 'octocat' })
    expect(github()).not.toBe(w.github)
    expect(github().kind).toBe('pat')
    expect(await refreshGitHubCredential()).toBe(false)
    await db().run(sql`delete from settings where key = 'octoforge_github'`)
    settings.reset()
    expect(await refreshGitHubCredential()).toBe(true)
    expect(githubCredential().source).toBe('none')
    // A broken value is ignored: env values stay in use.
    await db().run(sql`insert into settings (key, value, updated_at) values ('octoforge_github', 'not json', ${new Date().toISOString()})`)
    settings.reset()
    expect(await refreshGitHubCredential()).toBe(false)
    expect(githubCredential().source).toBe('none')
  })

  test('database routes: adopt and drop answer {ok}, never echo the url', async () => {
    await world()
    const a = app()
    // DELETE removes DATA_DIR/octoforge-database.json; on a live node that is the adopted database.
    expect(config().dataDir).toStartWith(tmpdir())
    const url = 'postgres://octohatchery:s3cret-pass@db.invalid:5432/forge'
    const r = await call(a, 'POST', '/api/octoforge/database/adopt', { url, schema: 'octohatchery', copy: false }, AUTH)
    expect(typeof r.json.ok).toBe('boolean')
    if (!r.json.ok) expect(r.status).toBeGreaterThanOrEqual(400)
    else expect(r.json.restart_required).toBe(true)
    expect(r.text).not.toContain('s3cret-pass')
    expect((await call(a, 'POST', '/api/octoforge/database/adopt', { url, schema: 'Bad Schema' }, AUTH)).status).toBe(400)
    const d = await call(a, 'DELETE', '/api/octoforge/database', undefined, AUTH)
    expect(typeof d.json.ok).toBe('boolean')
    if (d.json.ok) expect(d.json).toMatchObject({ restart_required: true, removed: expect.any(Boolean) })
    else expect(d.status).toBeGreaterThanOrEqual(400)
  })
})

describe('waiting for a delivery', () => {
  test('starts with no GitHub env when OCTOFORGE_TOKEN is set; GitHub calls fail with the reason', async () => {
    expect(() => loadConfig({ DATABASE_URL: 'sqlite::memory:' })).toThrow(ConfigError)
    expect(() => loadConfig({ DATABASE_URL: 'sqlite::memory:' })).toThrow('GITHUB_AUTH=app needs GITHUB_APP_ID')
    const cfg = loadConfig({ DATABASE_URL: 'sqlite::memory:', OCTOFORGE_TOKEN: TOKEN })
    expect(cfg).toMatchObject({ githubAuth: 'none', githubAwaitingDelivery: true })
    expect(loadConfig({ DATABASE_URL: 'sqlite::memory:', OCTOFORGE_TOKEN: TOKEN, GITHUB_AUTH: 'none' }).githubAwaitingDelivery).toBe(false)

    await world({ GITHUB_AUTH: '', GITHUB_WEBHOOK_SECRET: '' })
    setGitHub(undefined)
    const a = app()
    expect(github().kind).toBe('none')
    const s = await call(a, 'GET', '/api/octoforge/status', undefined, AUTH)
    expect(s.json.github).toEqual({ mode: 'none', source: 'none' })
    const r = await call(a, 'POST', '/api/repos/adopt', { fullName: 'acme/app' })
    expect(r.status).toBe(503)
    expect(r.json.message).toContain('no GitHub credential yet')
    await expect(github().createJitConfig({ repo: 'acme/app', name: 'x', labels: [] })).rejects.toThrow('no GitHub credential yet')
    // The delivery switches the node over without a restart.
    await call(a, 'PUT', '/api/octoforge/github', { mode: 'pat', token: PAT }, AUTH)
    expect(github().kind).toBe('pat')
  })
})

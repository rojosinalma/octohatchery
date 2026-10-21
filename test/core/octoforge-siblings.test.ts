import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { fresh } from './helpers'
import { db } from '../../src/db'
import { sql } from 'drizzle-orm'
import { setConfig, loadConfig } from '../../src/lib/config'
import { SIBLINGS_KEY, switcher } from '../../src/lib/octoforge/siblings'
import { settings } from '../../src/lib/settings'
import { api } from '../../src/routes/api'
import { octoforge } from '../../src/routes/octoforge'
import { MemberSwitcher } from '../../src/views/layout'

const TOKEN = 'forge-token-0123456789'
const AUTH = { authorization: `Bearer ${TOKEN}` }

const LIST = {
  forge: { title: 'Octoforge', url: 'https://forge.example.com', icon: 'https://forge.example.com/favicon.svg' },
  members: [
    { name: 'octohatchery', title: 'OctoHatchery', url: 'https://hatchery.example.com', icon: 'https://hatchery.example.com/favicon.svg' },
    { name: 'octotally', title: 'Octotally', url: 'https://tally.example.com', icon: 'https://tally.example.com/favicon.svg' },
  ],
  updated_at: new Date().toISOString(),
}

const app = () => new Elysia().use(api).use(octoforge)

async function call(a: ReturnType<typeof app>, method: string, path: string, body?: unknown, headers: Record<string, string> = AUTH) {
  const res = await a.handle(
    new Request(`http://local${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }),
  )
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

const events = async () => (await db().all<{ action: string }>(sql`select action from events where actor = 'octoforge' order by id`)).map((e) => e.action)

describe('sibling list', () => {
  test('without OCTOFORGE_TOKEN the routes answer 404 and no switcher shows, even with a stored list', async () => {
    await fresh()
    const a = app()
    expect((await call(a, 'PUT', '/api/octoforge/siblings', LIST)).status).toBe(404)
    expect((await call(a, 'DELETE', '/api/octoforge/siblings')).status).toBe(404)
    await settings.set(SIBLINGS_KEY, JSON.stringify(LIST))
    expect(await switcher()).toBeUndefined()
  })

  test('needs the bearer token', async () => {
    await fresh({ OCTOFORGE_TOKEN: TOKEN })
    const r = await call(app(), 'PUT', '/api/octoforge/siblings', LIST, { authorization: 'Bearer wrong' })
    expect(r.status).toBe(401)
    expect(await switcher()).toBeUndefined()
  })

  test('PUT stores the list, marks this app, logs one event per change; DELETE clears it', async () => {
    await fresh({ OCTOFORGE_TOKEN: TOKEN })
    const a = app()
    const r = await call(a, 'PUT', '/api/octoforge/siblings', LIST)
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, members: 2, changed: true })
    const s = await switcher()
    expect(s?.forge).toEqual(LIST.forge)
    expect(s?.members.map((m) => [m.name, m.current])).toEqual([
      ['octohatchery', true],
      ['octotally', false],
    ])

    // The hourly resend with a new timestamp only is not a change.
    const later = new Date(Date.now() + 1000).toISOString()
    const again = await call(a, 'PUT', '/api/octoforge/siblings', { ...LIST, updated_at: later })
    expect(again.json).toMatchObject({ ok: true, changed: false })
    expect((await switcher())?.updatedAt).toBe(later)
    expect(await events()).toEqual(['siblings.updated'])

    // Hidden from the settings API and refused there.
    const all = await call(a, 'GET', '/api/settings', undefined, {})
    expect(JSON.stringify(all.json)).not.toContain(SIBLINGS_KEY)
    expect((await call(a, 'PUT', `/api/settings/${SIBLINGS_KEY}`, { value: '{}' }, {})).status).toBeGreaterThanOrEqual(400)

    const d = await call(a, 'DELETE', '/api/octoforge/siblings')
    expect(d.json).toMatchObject({ ok: true, removed: true })
    expect(await switcher()).toBeUndefined()
    expect((await call(a, 'DELETE', '/api/octoforge/siblings')).json).toMatchObject({ ok: true, removed: false })
    expect(await events()).toEqual(['siblings.updated', 'siblings.cleared'])
  })

  test('refuses bodies that are not a sibling list; nothing is stored', async () => {
    await fresh({ OCTOFORGE_TOKEN: TOKEN })
    const a = app()
    const member = LIST.members[1]!
    for (const body of [
      {},
      { ...LIST, forge: { ...LIST.forge, url: 'javascript:alert(1)' } },
      { ...LIST, members: [{ ...member, icon: '/favicon.svg' }] },
      { ...LIST, members: [{ ...member, name: 'Not A Name' }] },
      { ...LIST, updated_at: 'yesterday' },
      { ...LIST, members: Array.from({ length: 51 }, (_, i) => ({ ...member, name: `m${i}` })) },
    ]) {
      const r = await call(a, 'PUT', '/api/octoforge/siblings', body)
      expect(r.status).toBe(400)
      expect(r.json).toMatchObject({ ok: false, code: 'invalid' })
    }
    expect(await settings.fetch(SIBLINGS_KEY, '')).toBe('')
  })

  test('a corrupt stored value shows no switcher', async () => {
    await fresh({ OCTOFORGE_TOKEN: TOKEN })
    await settings.set(SIBLINGS_KEY, '{"forge":1}')
    expect(await switcher()).toBeUndefined()
  })

  test('the switcher renders Octoforge first, every member with its icon, this app marked, titles escaped', async () => {
    await fresh({ OCTOFORGE_TOKEN: TOKEN })
    await call(app(), 'PUT', '/api/octoforge/siblings', { ...LIST, members: [...LIST.members, { name: 'octowarden', title: '<b>Warden</b>', url: 'https://warden.example.com', icon: 'https://warden.example.com/i.svg' }] })
    const html = String(await MemberSwitcher({ siblings: await switcher() }))
    expect(html).toContain('id="member-switcher"')
    expect(html).toContain('data-tip="Octoforge apps"')
    const hrefs = [...html.matchAll(/href="(https:[^"]+)"/g)].map((m) => m[1])
    expect(hrefs).toEqual(['https://forge.example.com', 'https://hatchery.example.com', 'https://tally.example.com', 'https://warden.example.com'])
    expect(html).toContain('src="https://tally.example.com/favicon.svg"')
    expect(html).toMatch(/href="https:\/\/hatchery\.example\.com" aria-current="page" data-member="octohatchery"/)
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1)
    expect(html).toContain('this app')
    expect(html).toContain('&lt;b&gt;Warden&lt;/b&gt;')
    expect(html).not.toContain('<b>Warden')
    expect(String(MemberSwitcher({ siblings: undefined }) ?? '')).toBe('')
  })

  test('a list older than siblings_stale_minutes (by updated_at) hides the switcher; the next list shows it again', async () => {
    await fresh({ OCTOFORGE_TOKEN: TOKEN })
    const a = app()
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
    await call(a, 'PUT', '/api/octoforge/siblings', { ...LIST, updated_at: ago(179) })
    expect(await switcher()).toBeDefined()
    await call(a, 'PUT', '/api/octoforge/siblings', { ...LIST, updated_at: ago(181) })
    expect(await switcher()).toBeUndefined()
    await settings.set('siblings_stale_minutes', '300')
    expect(await switcher()).toBeDefined()
    await settings.set('siblings_stale_minutes', '0')
    expect(await switcher()).toBeDefined()
    await settings.set('siblings_stale_minutes', '180')
    expect(await switcher()).toBeUndefined()
    // Octoforge's next send carries a fresh updated_at.
    await call(a, 'PUT', '/api/octoforge/siblings', { ...LIST, updated_at: ago(0) })
    const html = String(await MemberSwitcher({ siblings: await switcher() }))
    expect(html).toContain('id="member-switcher"')
    expect(html).not.toContain('stale')
  })

  test('a list stored by 0.3.2 (with received_at) still reads', async () => {
    await fresh({ OCTOFORGE_TOKEN: TOKEN })
    await settings.set(SIBLINGS_KEY, JSON.stringify({ ...LIST, received_at: new Date().toISOString() }))
    expect((await switcher())?.members).toHaveLength(2)
  })

  test('the token removed later hides the switcher again', async () => {
    await fresh({ OCTOFORGE_TOKEN: TOKEN })
    await call(app(), 'PUT', '/api/octoforge/siblings', LIST)
    expect(await switcher()).toBeDefined()
    setConfig(loadConfig({ DATABASE_URL: 'sqlite::memory:', GITHUB_AUTH: 'none', CONTAINER_BACKEND: 'fake', HOST_NAME: 'node-a', MODE: 'single' }))
    expect(await switcher()).toBeUndefined()
  })
})

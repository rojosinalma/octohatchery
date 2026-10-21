import { describe, expect, test } from 'bun:test'
import { fresh } from './helpers'
import { jsonErr, jsonOk } from '../../src/lib/json'
import { loadConfig, ConfigError } from '../../src/lib/config'
import { settings, SETTING_DEFAULTS } from '../../src/lib/settings'
import { service } from '../../src/lib/service'
import { ServiceError } from '../../src/lib/types'
import { sqlitePath } from '../../src/db/drivers/sqlite'

describe('json helpers', () => {
  test('jsonOk spreads data under ok/message', () => {
    expect(jsonOk({ a: 1 }, 'done')).toEqual({ ok: true, message: 'done', a: 1 })
    expect(jsonOk()).toEqual({ ok: true, message: 'ok' })
  })
  test('jsonErr carries code and status', () => {
    expect(jsonErr('nope', 'not_found', 404)).toEqual({ body: { ok: false, message: 'nope', code: 'not_found' }, status: 404 })
    expect(jsonErr('bad').status).toBe(400)
  })
})

describe('config', () => {
  test('defaults in single mode', () => {
    const c = loadConfig({ GITHUB_AUTH: 'none' })
    expect(c.port).toBe(3000)
    expect(c.mode).toBe('single')
    expect(c.databaseUrl).toBe('sqlite:./data/octohatchery.db')
    expect(c.backend).toBe('docker')
  })
  test('cluster mode on sqlite fails fast with a reason', () => {
    expect(() => loadConfig({ MODE: 'cluster', GITHUB_AUTH: 'none' })).toThrow(ConfigError)
    expect(() => loadConfig({ MODE: 'cluster', GITHUB_AUTH: 'none' })).toThrow(/postgres/)
  })
  test('app auth needs its id and key; PEM newlines are restored', () => {
    expect(() => loadConfig({ GITHUB_AUTH: 'app' })).toThrow(/GITHUB_APP_ID/)
    const c = loadConfig({
      GITHUB_AUTH: 'app',
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: '-----BEGIN\\nabc\\n-----END',
      GITHUB_APP_INSTALLATION_ID: '2',
      GITHUB_WEBHOOK_SECRET: 's',
    })
    expect(c.githubAppPrivateKey).toBe('-----BEGIN\nabc\n-----END')
    // The installation id is optional (installations are discovered) but must be a number when set.
    const base = { GITHUB_AUTH: 'app', GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'k', GITHUB_WEBHOOK_SECRET: 's' }
    expect(loadConfig(base).githubAppInstallationId).toBeUndefined()
    expect(() => loadConfig({ ...base, GITHUB_APP_INSTALLATION_ID: 'abc' })).toThrow(/GITHUB_APP_INSTALLATION_ID/)
  })
  test('pat auth needs a token and a webhook secret', () => {
    expect(() => loadConfig({ GITHUB_AUTH: 'pat' })).toThrow(/GITHUB_TOKEN/)
    expect(() => loadConfig({ GITHUB_AUTH: 'pat', GITHUB_TOKEN: 'x' })).toThrow(/GITHUB_WEBHOOK_SECRET/)
  })
  test('sqlite url to path', () => {
    expect(sqlitePath('sqlite::memory:')).toBe(':memory:')
    expect(sqlitePath('sqlite:./data/x.db')).toBe('./data/x.db')
  })
})

describe('settings', () => {
  test('fetch falls back to the default, set persists, all overlays defaults', async () => {
    await fresh()
    expect(await settings.fetch('poll_interval_s', '300')).toBe('300')
    await settings.set('poll_interval_s', '60')
    expect(await settings.fetch('poll_interval_s', '300')).toBe('60')
    expect(await settings.fetchInt('poll_interval_s', 300)).toBe(60)
    const all = await settings.all()
    expect(all.poll_interval_s).toBe('60')
    expect(all.retention_days).toBe(SETTING_DEFAULTS.retention_days)
  })
  test('service.setSetting validates key and value', async () => {
    await fresh()
    await expect(service.setSetting('nope', '1', 'user')).rejects.toBeInstanceOf(ServiceError)
    await expect(service.setSetting('retention_days', 'ten', 'user')).rejects.toThrow(/integer/)
    await expect(service.setSetting('log_level', 'loud', 'user')).rejects.toThrow(/log_level/)
    await service.setSetting('log_level', 'debug', 'user')
    expect((await service.getSettings()).log_level).toBe('debug')
    const events = await service.listEvents()
    expect(events[0]?.action).toBe('setting.set')
  })
})

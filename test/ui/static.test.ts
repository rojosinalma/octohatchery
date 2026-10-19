import { describe, expect, mock, test } from 'bun:test'
import { full, makeService } from './fixtures'

mock.module('../../src/lib/service', () => ({ service: makeService({ data: full }) }))

const { ui } = await import('../../src/routes/ui')

const get = (path: string) => ui.handle(new Request(`http://localhost${path}`))

describe('static files', () => {
  test('serves public/ under /public/*', async () => {
    const res = await get('/public/app.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(await res.text()).toContain("new EventSource('/events/stream')")
  })

  test('serves tailor assets at /tailor/* (where the vendored head snippet expects them)', async () => {
    const res = await get('/tailor/tokens.css')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('max-age=3600')
    expect(await res.text()).toContain('managed by tailor')
  })

  test('favicon at the root is the gruvbox octopus mark', async () => {
    const res = await get('/favicon.svg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('svg')
    const svg = await res.text()
    expect(svg).toContain('viewBox="0 0 32 32"')
    expect(svg).toContain('#282828')
    expect(svg).toContain('#fabd2f')
    expect(svg).toContain('<title')
  })

  test('missing file is 404', async () => {
    expect((await get('/public/nope.css')).status).toBe(404)
  })

  test.each(['/public/..%2F.env', '/public/..%2f..%2fetc%2fpasswd', '/public/%2e%2e%2ftsconfig.json', '/tailor/..%2F..%2Fpackage.json', '/public/tailor%2F..%2F..%2Fpackage.json', '/public/%00'])(
    'path traversal %s is rejected',
    async (path) => {
      const res = await get(path)
      expect(res.status).toBe(404)
      const body = await res.text()
      expect(body).not.toContain('compilerOptions')
      expect(body).not.toContain('"name"')
    },
  )

  test('a bad percent-encoding is a 400', async () => {
    expect((await get('/public/%E0%A4%A')).status).toBe(400)
  })
})

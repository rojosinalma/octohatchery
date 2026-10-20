import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { sql } from 'drizzle-orm'
import { fresh, TEST_HOST } from './helpers'
import { api } from '../../src/routes/api'
import { stream } from '../../src/routes/stream'
import { service } from '../../src/lib/service'
import { heartbeat } from '../../src/lib/sweep'
import { tick } from '../../src/lib/scheduler'
import { awaitImagePull, reportImages, startImagePull, wantedImages } from '../../src/lib/images'
import { bus, type ImageEvent } from '../../src/lib/bus'
import { imagesFromSummaries } from '../../src/lib/backends/docker'
import { DIND_IMAGE } from '../../src/lib/spawn'
import { DEFAULT_RUNNER_IMAGE } from '../../src/db/seed'

const digest = (ref: string) => `sha256:${ref.replace(/[^a-z0-9]/gi, '').padEnd(64, '0').slice(0, 64)}`

describe('image inventory', () => {
  test('wanted references = template images + default + dind, each once, sorted', async () => {
    await fresh()
    const wanted = await wantedImages()
    expect(wanted).toEqual([...new Set([DEFAULT_RUNNER_IMAGE, 'ghcr.io/rojosinalma/octohatchery-runner:edge', DIND_IMAGE])].sort())
    await service.upsertRunnerType({ name: 'gpu', description: null, labels: [], image: 'ghcr.io/x/gpu:1', cpus: 1, memoryMb: 1024, mounts: [], env: {}, secretEnv: [], docker: 'none' }, 'user')
    expect(await wantedImages()).toContain('ghcr.io/x/gpu:1')
  })

  test('heartbeat stores what the engine has for wanted references and drops rows for images that vanished', async () => {
    const w = await fresh()
    w.docker.images.set(DIND_IMAGE, { reference: DIND_IMAGE, digest: digest(DIND_IMAGE), sizeBytes: 300_000_000, createdAt: '2026-10-01T00:00:00.000Z' })
    w.docker.images.set('unrelated:1', { reference: 'unrelated:1', digest: null, sizeBytes: 1, createdAt: null })
    const seen: ImageEvent[] = []
    const onImage = (ev: ImageEvent) => seen.push(ev)
    bus.on('image', onImage)
    try {
      await heartbeat()
      let inv = await service.listImages()
      expect(inv.images).toEqual([{ host: TEST_HOST, reference: DIND_IMAGE, digest: digest(DIND_IMAGE), sizeBytes: 300_000_000, pulledAt: '2026-10-01T00:00:00.000Z', seenAt: expect.any(String) }])
      expect(inv.references).toContain(DIND_IMAGE)
      expect(seen).toEqual([{ host: TEST_HOST }])
      // unchanged inventory → no event
      expect(await reportImages()).toBe(false)
      expect(seen).toHaveLength(1)
      // image removed from the engine → row gone, one event
      w.docker.images.delete(DIND_IMAGE)
      expect(await reportImages()).toBe(true)
      inv = await service.listImages()
      expect(inv.images).toEqual([])
      expect(seen).toHaveLength(2)
    } finally {
      bus.off('image', onImage)
    }
  })

  test('a docker image summary becomes one entry per tag with the repo digest, size and creation time', () => {
    const out = imagesFromSummaries([
      { RepoTags: ['docker:28-dind', 'docker:dind'], RepoDigests: ['docker@sha256:' + 'a'.repeat(64)], Size: 10, Created: 1_700_000_000 },
      { RepoTags: ['<none>:<none>'], RepoDigests: [], Size: 5, Created: 1 },
      { RepoTags: null, RepoDigests: null },
    ])
    expect(out).toEqual([
      { reference: 'docker:28-dind', digest: 'sha256:' + 'a'.repeat(64), sizeBytes: 10, createdAt: '2023-11-14T22:13:20.000Z' },
      { reference: 'docker:dind', digest: 'sha256:' + 'a'.repeat(64), sizeBytes: 10, createdAt: '2023-11-14T22:13:20.000Z' },
    ])
  })
})

describe('image pulls', () => {
  test('a queued pull is claimed by the scheduler tick, run on the local engine, recorded, and announced', async () => {
    const w = await fresh()
    const seen: ImageEvent[] = []
    const onImage = (ev: ImageEvent) => seen.push(ev)
    bus.on('image', onImage)
    try {
      const pull = await service.pullImage({ host: TEST_HOST, reference: DIND_IMAGE }, 'user')
      expect(pull).toMatchObject({ host: TEST_HOST, reference: DIND_IMAGE, status: 'queued', requestedBy: 'user' })
      // a second request for the same cell returns the queued one
      expect((await service.pullImage({ host: TEST_HOST, reference: DIND_IMAGE }, 'mcp:x')).id).toBe(pull.id)
      await tick()
      await awaitImagePull()
      expect(w.docker.pulls).toEqual([DIND_IMAGE])
      const inv = await service.listImages()
      expect(inv.pulls).toEqual([expect.objectContaining({ id: pull.id, status: 'done', error: null, finishedAt: expect.any(String) })])
      expect(inv.images.map((i) => i.reference)).toEqual([DIND_IMAGE])
      expect(seen.filter((e) => e.status).map((e) => e.status)).toEqual(['queued', 'running', 'done'])
      expect(seen.some((e) => !e.status)).toBe(true) // the inventory refresh after the pull
      const events = await service.listEvents()
      expect(events.map((e) => e.action)).toContain('image.pulled')
      expect(events.find((e) => e.action === 'image.pull')).toMatchObject({ actor: 'user', target: `${DIND_IMAGE} on ${TEST_HOST}` })
    } finally {
      bus.off('image', onImage)
    }
  })

  test('a failed pull keeps the engine error and leaves the cell missing', async () => {
    const w = await fresh()
    w.docker.pullFails.set(DIND_IMAGE, 'manifest unknown')
    await service.pullImage({ host: TEST_HOST, reference: DIND_IMAGE }, 'user')
    expect(await startImagePull()).toMatchObject({ status: 'running' })
    await awaitImagePull()
    const inv = await service.listImages()
    expect(inv.pulls[0]).toMatchObject({ status: 'failed', error: 'manifest unknown' })
    expect(inv.images).toEqual([])
    expect((await service.listEvents()).map((e) => e.action)).toContain('image.pull_failed')
  })

  test('pulls for another host are left alone; one pull runs at a time per node', async () => {
    const w = await fresh()
    await w.db.run(sql`insert into hosts (name, status, last_seen_at, is_leader, docker_ok) values ('node-b', 'online', ${new Date().toISOString()}, false, true)`)
    await service.pullImage({ host: 'node-b', reference: DIND_IMAGE }, 'user')
    await service.pullImage({ host: TEST_HOST, reference: DIND_IMAGE }, 'user')
    await service.pullImage({ host: TEST_HOST, reference: DEFAULT_RUNNER_IMAGE }, 'user')
    expect((await startImagePull())?.reference).toBe(DIND_IMAGE)
    expect(await startImagePull()).toBeUndefined() // one in flight
    await awaitImagePull()
    expect((await startImagePull())?.reference).toBe(DEFAULT_RUNNER_IMAGE)
    await awaitImagePull()
    expect(await startImagePull()).toBeUndefined()
    const inv = await service.listImages()
    expect(inv.pulls.find((p) => p.host === 'node-b')?.status).toBe('queued')
    expect(inv.pulls.filter((p) => p.host === TEST_HOST).map((p) => p.status)).toEqual(['done', 'done'])
    expect(w.docker.pulls).toEqual([DIND_IMAGE, DEFAULT_RUNNER_IMAGE])
  })

  test('a pull left running by a dead node is failed on the next start', async () => {
    const w = await fresh()
    await w.db.run(sql`insert into image_pulls (host_id, reference, status, requested_by, created_at) values (1, ${DIND_IMAGE}, 'running', 'user', ${new Date().toISOString()})`)
    await startImagePull()
    expect((await service.listImages()).pulls[0]).toMatchObject({ status: 'failed', error: 'node restarted during the pull' })
  })

  test('validation: unknown host, offline host, bad or unwanted reference', async () => {
    const w = await fresh()
    await expect(service.pullImage({ host: 'nope', reference: DIND_IMAGE }, 'user')).rejects.toMatchObject({ code: 'not_found' })
    await expect(service.pullImage({ host: TEST_HOST, reference: 'Bad Ref!' }, 'user')).rejects.toMatchObject({ code: 'invalid' })
    await expect(service.pullImage({ host: TEST_HOST, reference: 'ghcr.io/else/where:1' }, 'user')).rejects.toThrow(/not used by any template/)
    await w.db.run(sql`update hosts set status = 'offline' where name = ${TEST_HOST}`)
    await expect(service.pullImage({ host: TEST_HOST, reference: DIND_IMAGE }, 'user')).rejects.toMatchObject({ code: 'unavailable' })
  })

  test('API: GET /api/images, GET /api/hosts/:name/images, POST /api/hosts/:name/images/pull; image events on the stream', async () => {
    const w = await fresh()
    const app = new Elysia().use(api).use(stream)
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.handle(new Request(`http://local${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }))
      return { status: res.status, json: (await res.json()) as Record<string, unknown> }
    }
    let r = await call('GET', '/api/images')
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, references: expect.arrayContaining([DIND_IMAGE]), images: [], pulls: [] })
    r = await call('POST', `/api/hosts/${TEST_HOST}/images/pull`, { reference: DIND_IMAGE })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, message: `pull of ${DIND_IMAGE} queued on ${TEST_HOST}`, pull: { status: 'queued' } })
    r = await call('POST', `/api/hosts/${TEST_HOST}/images/pull`, { reference: DIND_IMAGE })
    expect(r.json.message).toContain('already queued')
    r = await call('POST', `/api/hosts/${TEST_HOST}/images/pull`, { reference: 'x/y:z' })
    expect(r.status).toBe(400)
    r = await call('POST', '/api/hosts/ghost/images/pull', { reference: DIND_IMAGE })
    expect(r.status).toBe(404)
    r = await call('GET', `/api/hosts/${TEST_HOST}/images`)
    expect(r.json).toMatchObject({ ok: true, images: [], pulls: [{ reference: DIND_IMAGE, status: 'queued' }] })
    // the stream forwards image events
    const res = await app.handle(new Request('http://local/events/stream'))
    const reader = res.body!.getReader()
    await reader.read() // ": connected"
    await tick()
    await awaitImagePull()
    const chunk = new TextDecoder().decode((await reader.read()).value)
    expect(chunk).toContain('event: image')
    expect(chunk).toContain(`"host":"${TEST_HOST}"`)
    await reader.cancel()
    expect(w.docker.pulls).toEqual([DIND_IMAGE])
  })
})

import { describe, expect, test } from 'bun:test'
import { fresh, TEST_HOST } from './helpers'
import { reap } from '../../src/lib/scheduler'
import { service } from '../../src/lib/service'
import { DIND_IMAGE, dindName, hostSocketPath, runnerMounts, socketGid } from '../../src/lib/spawn'
import { removeStaleRunners } from '../../src/lib/sweep'
import { runnerById } from '../../src/lib/store'
import type { RunnerType } from '../../src/lib/types'

const base: Omit<RunnerType, 'id' | 'createdAt' | 'updatedAt'> = { name: 'x', description: null, labels: [], image: 'img', cpus: 1, memoryMb: 512, mounts: [], env: {}, secretEnv: [], docker: 'none' }

describe('runner docker access', () => {
  test('socket path from DOCKER_HOST; gid when the socket can be inspected', () => {
    expect(hostSocketPath(undefined)).toBe('/var/run/docker.sock')
    expect(hostSocketPath('unix:///run/user/1000/docker.sock')).toBe('/run/user/1000/docker.sock')
    expect(hostSocketPath('/custom.sock')).toBe('/custom.sock')
    expect(hostSocketPath('tcp://host:2375')).toBe('/var/run/docker.sock')
    expect(socketGid('/x', () => ({ gid: 994 }))).toBe('994')
    expect(socketGid('/x', () => { throw new Error('ENOENT') })).toBeUndefined()
  })

  test('mounts: the socket is added only for socket types', () => {
    expect(runnerMounts({ ...base, id: 1, createdAt: '', updatedAt: '' }, '/var/run/docker.sock')).toEqual(['octohatchery-tool-cache:/opt/hostedtoolcache'])
    expect(runnerMounts({ ...base, id: 1, createdAt: '', updatedAt: '', docker: 'socket' }, '/run/docker.sock')).toEqual(['octohatchery-tool-cache:/opt/hostedtoolcache', '/run/docker.sock:/var/run/docker.sock'])
  })

  test('upsert validates and stores the option; default none; the seeded types stay none', async () => {
    await fresh()
    for (const t of await service.listRunnerTypes()) expect(t.docker).toBe('none')
    await expect(service.upsertRunnerType({ ...base, name: 'bad', docker: 'host' as never }, 'user')).rejects.toMatchObject({ code: 'invalid' })
    const t = await service.upsertRunnerType({ ...base, name: 'dindy', docker: 'dind' }, 'user')
    expect(t.docker).toBe('dind')
    expect((await service.getRunnerType('dindy')).docker).toBe('dind')
    const back = await service.upsertRunnerType({ ...base, name: 'dindy', docker: 'socket' }, 'user')
    expect(back.docker).toBe('socket')
    const ev = (await service.listEvents()).find((e) => e.action === 'runner_type.upsert' && e.target === 'dindy')
    expect(ev?.detail.docker).toBe('socket')
  })

  test('socket type: runner gets the socket mount and the group', async () => {
    const w = await fresh()
    await service.adoptRepo('acme/app', 'user')
    await service.upsertRunnerType({ ...base, name: 'sock', docker: 'socket' }, 'user')
    await service.setSlots({ host: TEST_HOST, type: 'sock', count: 1 }, 'user')
    const runner = await service.spawn({ type: 'sock', host: TEST_HOST }, 'user')
    expect(runner.state).toBe('idle')
    const spawn = w.docker.spawns[0]!
    expect(spawn.mounts).toContain('/var/run/docker.sock:/var/run/docker.sock')
    // the test process may or may not see a docker socket: either a gid or no group at all, never an empty string
    expect(spawn.groupAdd === undefined || (spawn.groupAdd.length === 1 && /^\d+$/.test(spawn.groupAdd[0]!))).toBe(true)
    expect(spawn.env.DOCKER_HOST).toBeUndefined()
    expect(w.docker.sidecars.size).toBe(0)
  })

  test('dind type: sidecar first, runner joins its network, kill removes both', async () => {
    const w = await fresh()
    await service.adoptRepo('acme/app', 'user')
    await service.upsertRunnerType({ ...base, name: 'dindy', docker: 'dind' }, 'user')
    await service.setSlots({ host: TEST_HOST, type: 'dindy', count: 1 }, 'user')
    const runner = await service.spawn({ type: 'dindy', host: TEST_HOST }, 'user')
    expect(w.docker.sidecars.size).toBe(1)
    const sidecar = [...w.docker.sidecars.values()][0]!
    expect(sidecar.input).toMatchObject({ name: dindName(runner), image: DIND_IMAGE, role: 'dind', privileged: true, env: { DOCKER_TLS_CERTDIR: '' } })
    expect(sidecar.labels['octohatchery.runner-id']).toBe(String(runner.id))
    expect(sidecar.labels['octohatchery.runner']).toBeUndefined()
    // The runner shares the sidecar's network stack: the daemon and every port it publishes are on localhost.
    expect(w.docker.spawns[0]!.env.DOCKER_HOST).toBe('tcp://localhost:2375')
    expect(w.docker.spawns[0]!.network).toBe(`container:${sidecar.id}`)
    expect(w.docker.spawns[0]!.mounts).not.toContain('/var/run/docker.sock:/var/run/docker.sock')
    expect((await w.docker.listOwned()).length).toBe(1) // sidecars are not runners
    await service.kill(runner.id, 'user')
    expect(w.docker.containers.size).toBe(0)
    expect(w.docker.sidecars.size).toBe(0)
  })

  test('dind type: the reaper and the stale sweep remove the sidecar with the runner', async () => {
    const w = await fresh()
    await service.adoptRepo('acme/app', 'user')
    await service.upsertRunnerType({ ...base, name: 'dindy', docker: 'dind' }, 'user')
    await service.setSlots({ host: TEST_HOST, type: 'dindy', count: 2 }, 'user')
    const a = await service.spawn({ type: 'dindy', host: TEST_HOST }, 'user')
    w.docker.exit(a.containerId!, 0)
    await reap()
    expect((await runnerById(a.id))?.state).toBe('exited')
    expect(w.docker.sidecars.size).toBe(0)

    const b = await service.spawn({ type: 'dindy', host: TEST_HOST }, 'user')
    expect(w.docker.sidecars.size).toBe(1)
    await removeStaleRunners(Date.now() + 10 * 60_000)
    expect((await runnerById(b.id))?.state).toBe('removed')
    expect(w.docker.containers.size).toBe(0)
    expect(w.docker.sidecars.size).toBe(0)
  })

  test('dind type: a sidecar started before a failed spawn is removed again', async () => {
    const w = await fresh()
    await service.adoptRepo('acme/app', 'user')
    await service.upsertRunnerType({ ...base, name: 'dindy', docker: 'dind' }, 'user')
    await service.setSlots({ host: TEST_HOST, type: 'dindy', count: 1 }, 'user')
    const spawnRunner = w.docker.spawnRunner
    w.docker.spawnRunner = async () => { throw new Error('engine said no') }
    await expect(service.spawn({ type: 'dindy', host: TEST_HOST }, 'user')).rejects.toMatchObject({ code: 'unavailable' })
    w.docker.spawnRunner = spawnRunner
    expect(w.docker.sidecars.size).toBe(0)
  })
})

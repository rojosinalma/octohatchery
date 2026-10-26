import type { BackendAdapter, CacheVolumeInput, ContainerBackend, ContainerInfo, ContainerLogLine, ImageInfo, SidecarInput, SpawnInput, VolumeInput } from './types'
import { RUNNER_HOST_LABEL, RUNNER_ID_LABEL, RUNNER_LABEL, RUNNER_ROLE_LABEL, RUNNER_TYPE_LABEL } from './types'

/** A hand-driven log feed: `push` lines, `end` when the container exits. */
export type FakeLogFeed = AsyncIterable<ContainerLogLine> & { push(line: string, at?: string): void; end(): void }

export function createLogFeed(): FakeLogFeed {
  const queue: ContainerLogLine[] = []
  let ended = false
  let wake: (() => void) | undefined
  const notify = () => {
    wake?.()
    wake = undefined
  }
  return {
    push(line, at = new Date().toISOString()) {
      queue.push({ at, line })
      notify()
    },
    end() {
      ended = true
      notify()
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) {
          yield queue.shift()!
          continue
        }
        if (ended) return
        await new Promise<void>((resolve) => (wake = resolve))
      }
    },
  }
}

/** In-memory backend for tests: containers are records; `exit(id)` simulates the runner finishing. */
export type FakeBackend = ContainerBackend & {
  containers: Map<string, ContainerInfo & { input: SpawnInput }>
  spawns: SpawnInput[]
  /** Sidecars by id; removed together with their runner by `removeByRunnerId`. */
  sidecars: Map<string, ContainerInfo & { input: SidecarInput }>
  /** Volumes by name, with the runner they belong to. */
  volumes: Map<string, VolumeInput>
  /** Cache volumes by name. A volume is in use while a sidecar lists it in its mounts. */
  cacheVolumes: Map<string, CacheVolumeInput>
  /** Commands run through `exec`, with the container they ran in. */
  execs: { containerId: string; cmd: string[] }[]
  up: boolean
  /** Images the fake engine holds, by reference; `pull` adds one (or fails when its reference is in `pullFails`). */
  images: Map<string, ImageInfo>
  pullFails: Map<string, string>
  pulls: string[]
  exit(containerId: string, code?: number): void
  /** Log feed per container; `logs()` drains it. Created on demand so tests can push before or after following. */
  feed(containerId: string): FakeLogFeed
  /** Simulates a node restart: the current follower stays stuck on the old feed, the next `logs()` call gets a new one. */
  replaceFeed(containerId: string): FakeLogFeed
}

export function createFakeBackend(): FakeBackend {
  const containers = new Map<string, ContainerInfo & { input: SpawnInput }>()
  const spawns: SpawnInput[] = []
  const sidecars = new Map<string, ContainerInfo & { input: SidecarInput }>()
  const feeds = new Map<string, FakeLogFeed>()
  const images = new Map<string, ImageInfo>()
  let n = 0
  const fake: FakeBackend = {
    kind: 'fake',
    containers,
    spawns,
    sidecars,
    volumes: new Map(),
    cacheVolumes: new Map(),
    execs: [],
    images,
    pullFails: new Map(),
    pulls: [],
    up: true,
    exit(id, code = 0) {
      const c = containers.get(id)
      if (c) Object.assign(c, { running: false, status: 'exited', exitCode: code })
      feeds.get(id)?.end()
    },
    feed(id) {
      let f = feeds.get(id)
      if (!f) feeds.set(id, (f = createLogFeed()))
      return f
    },
    replaceFeed(id) {
      const f = createLogFeed()
      feeds.set(id, f)
      return f
    },
    async ping() {
      return fake.up
    },
    async info() {
      return fake.up ? { version: 'fake-1.0', os: 'Fake OS 1', cpus: 4, memoryMb: 8192 } : null
    },
    async spawnRunner(input) {
      const id = `fake-${++n}`
      spawns.push(input)
      containers.set(id, {
        id,
        status: 'running',
        running: true,
        exitCode: null,
        labels: {
          [RUNNER_LABEL]: 'true',
          [RUNNER_ID_LABEL]: String(input.runner.id),
          [RUNNER_TYPE_LABEL]: input.runner.type,
          [RUNNER_HOST_LABEL]: input.runner.host,
        },
        input,
      })
      return id
    },
    async exec(containerId, cmd) {
      fake.execs.push({ containerId, cmd })
      return 0
    },
    async createVolume(input) {
      fake.volumes.set(input.name, input)
      return input.name
    },
    async listRunnerVolumes() {
      return [...fake.volumes.values()].map((v) => ({ name: v.name, runnerId: String(v.runner.id), host: v.runner.host }))
    },
    async listCacheVolumes() {
      const used = new Set([...sidecars.values()].flatMap((s) => (s.input.mounts ?? []).map((m) => m.split(':')[0]!)))
      return [...fake.cacheVolumes.values()].map((v) => ({ ...v, inUse: used.has(v.name) }))
    },
    async createCacheVolume(input) {
      if (!fake.cacheVolumes.has(input.name)) fake.cacheVolumes.set(input.name, input)
      return input.name
    },
    async removeVolume(name) {
      fake.cacheVolumes.delete(name)
      fake.volumes.delete(name)
    },
    async spawnSidecar(input) {
      const id = `fake-sidecar-${++n}`
      sidecars.set(id, {
        id,
        status: 'running',
        running: true,
        exitCode: null,
        labels: {
          [RUNNER_ID_LABEL]: String(input.runner.id),
          [RUNNER_TYPE_LABEL]: input.runner.type,
          [RUNNER_HOST_LABEL]: input.runner.host,
          [RUNNER_ROLE_LABEL]: input.role,
        },
        input,
      })
      return id
    },
    async inspect(id) {
      return containers.get(id) ?? sidecars.get(id) ?? { id, status: 'missing', running: false, exitCode: null, labels: {} }
    },
    async remove(id) {
      containers.delete(id)
      sidecars.delete(id)
    },
    async removeByRunnerId(runnerId) {
      for (const [id, c] of containers) if (c.labels[RUNNER_ID_LABEL] === String(runnerId)) containers.delete(id)
      for (const [id, c] of sidecars) if (c.labels[RUNNER_ID_LABEL] === String(runnerId)) sidecars.delete(id)
      for (const [name, v] of fake.volumes) if (v.runner.id === runnerId) fake.volumes.delete(name)
    },
    async listOwned() {
      return [...containers.values()]
    },
    logs(id) {
      return fake.feed(id)
    },
    async listImages() {
      if (!fake.up) throw new Error('fake engine is down')
      return [...images.values()]
    },
    async pull(reference) {
      fake.pulls.push(reference)
      const fail = fake.pullFails.get(reference)
      if (fail) throw new Error(fail)
      images.set(reference, { reference, digest: `sha256:${reference.replace(/[^a-z0-9]/gi, '').padEnd(64, '0').slice(0, 64)}`, sizeBytes: 1_000_000, createdAt: new Date().toISOString() })
    },
  }
  return fake
}

export const fakeBackend: BackendAdapter = { kind: 'fake', create: createFakeBackend }

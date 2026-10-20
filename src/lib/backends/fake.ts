import type { BackendAdapter, ContainerBackend, ContainerInfo, ContainerLogLine, SpawnInput } from './types'
import { RUNNER_HOST_LABEL, RUNNER_ID_LABEL, RUNNER_LABEL, RUNNER_TYPE_LABEL } from './types'

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
  up: boolean
  exit(containerId: string, code?: number): void
  /** Log feed per container; `logs()` drains it. Created on demand so tests can push before or after following. */
  feed(containerId: string): FakeLogFeed
  /** Simulates a node restart: the current follower stays stuck on the old feed, the next `logs()` call gets a new one. */
  replaceFeed(containerId: string): FakeLogFeed
}

export function createFakeBackend(): FakeBackend {
  const containers = new Map<string, ContainerInfo & { input: SpawnInput }>()
  const spawns: SpawnInput[] = []
  const feeds = new Map<string, FakeLogFeed>()
  let n = 0
  const fake: FakeBackend = {
    kind: 'fake',
    containers,
    spawns,
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
    async inspect(id) {
      return containers.get(id) ?? { id, status: 'missing', running: false, exitCode: null, labels: {} }
    },
    async remove(id) {
      containers.delete(id)
    },
    async listOwned() {
      return [...containers.values()]
    },
    logs(id) {
      return fake.feed(id)
    },
  }
  return fake
}

export const fakeBackend: BackendAdapter = { kind: 'fake', create: createFakeBackend }

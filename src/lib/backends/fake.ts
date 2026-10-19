import type { BackendAdapter, ContainerBackend, ContainerInfo, SpawnInput } from './types'
import { RUNNER_HOST_LABEL, RUNNER_ID_LABEL, RUNNER_LABEL, RUNNER_TYPE_LABEL } from './types'

/** In-memory backend for tests: containers are records; `exit(id)` simulates the runner finishing. */
export type FakeBackend = ContainerBackend & {
  containers: Map<string, ContainerInfo & { input: SpawnInput }>
  spawns: SpawnInput[]
  up: boolean
  exit(containerId: string, code?: number): void
}

export function createFakeBackend(): FakeBackend {
  const containers = new Map<string, ContainerInfo & { input: SpawnInput }>()
  const spawns: SpawnInput[] = []
  let n = 0
  const fake: FakeBackend = {
    kind: 'fake',
    containers,
    spawns,
    up: true,
    exit(id, code = 0) {
      const c = containers.get(id)
      if (c) Object.assign(c, { running: false, status: 'exited', exitCode: code })
    },
    async ping() {
      return fake.up
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
  }
  return fake
}

export const fakeBackend: BackendAdapter = { kind: 'fake', create: createFakeBackend }

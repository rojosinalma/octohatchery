import type { Runner, RunnerType } from '../types'

export type ContainerInfo = {
  id: string
  /** `running` | `exited` | `created` | … as reported by the engine; `missing` when it no longer exists. */
  status: string
  running: boolean
  exitCode: number | null
  labels: Record<string, string>
}

export type SpawnInput = {
  runner: Pick<Runner, 'id' | 'name' | 'host' | 'type'>
  type: RunnerType
  jitconfig: string
  env: Record<string, string>
  /** `src:dst[:ro]` entries, already resolved. */
  mounts: string[]
  network: string
}

/** Labels every runner container carries; `listOwned` filters on the first one. */
export const RUNNER_LABEL = 'octohatchery.runner'
export const RUNNER_ID_LABEL = 'octohatchery.runner-id'
export const RUNNER_TYPE_LABEL = 'octohatchery.type'
export const RUNNER_HOST_LABEL = 'octohatchery.host'

/** One line of container output with the engine's timestamp (ISO-8601). */
export type ContainerLogLine = { at: string; line: string }

export type ContainerBackend = {
  kind: 'docker' | 'fake'
  ping(): Promise<boolean>
  /** Creates and starts the container; returns its id. */
  spawnRunner(input: SpawnInput): Promise<string>
  inspect(containerId: string): Promise<ContainerInfo>
  /** Removes the container (force). Missing containers are not an error. */
  remove(containerId: string): Promise<void>
  /** Every container labelled `octohatchery.runner=true`, running or exited. */
  listOwned(): Promise<ContainerInfo[]>
  /**
   * Follows stdout and stderr of a running container until it exits; `since` (ISO-8601) skips older output.
   * Returning from the iterator (`break`) stops following. A missing container yields nothing.
   */
  logs(containerId: string, opts?: { since?: string }): AsyncIterable<ContainerLogLine>
}

export type BackendAdapter = { kind: ContainerBackend['kind']; create(): ContainerBackend }

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
  /** Extra groups for the container's user (the host's docker socket group when the type mounts the socket). */
  groupAdd?: string[]
  /** `uid:gid` the container runs as; unset = the user the image declares. */
  user?: string
}

/** A helper container that lives and dies with one runner (today: the Docker-in-Docker daemon). */
export type SidecarInput = {
  runner: Pick<Runner, 'id' | 'name' | 'host' | 'type'>
  /** Container name; the runner reaches it under this name on the network. */
  name: string
  image: string
  role: string
  env: Record<string, string>
  network: string
  privileged: boolean
  /** Command (the image's CMD) to run; unset = the image's default. */
  cmd?: string[]
  /** `src:dst[:opts]` entries, already resolved (the dind sidecar: the runner's work volume). */
  mounts?: string[]
}

/** A named volume that lives and dies with one runner (today: the work directory shared with the dind daemon). */
export type VolumeInput = {
  runner: Pick<Runner, 'id' | 'name' | 'host' | 'type'>
  name: string
}

/** A volume labelled with a runner id, as `listRunnerVolumes` reports it. */
export type RunnerVolume = { name: string; runnerId: string; host: string }

/** Labels every runner container carries; `listOwned` filters on the first one. */
export const RUNNER_LABEL = 'octohatchery.runner'
export const RUNNER_ID_LABEL = 'octohatchery.runner-id'
export const RUNNER_TYPE_LABEL = 'octohatchery.type'
export const RUNNER_HOST_LABEL = 'octohatchery.host'
/** Sidecars carry the runner id and host labels plus this role; they never carry `octohatchery.runner`. */
export const RUNNER_ROLE_LABEL = 'octohatchery.role'

/** What the engine reports about the machine it runs on; fields it does not know are null. */
export type EngineInfo = { version: string | null; os: string | null; cpus: number | null; memoryMb: number | null }

/** One image on the engine, once per tag it carries; `digest` is the repo digest when known. */
export type ImageInfo = { reference: string; digest: string | null; sizeBytes: number | null; createdAt: string | null }

/** One line of container output with the engine's timestamp (ISO-8601). */
export type ContainerLogLine = { at: string; line: string }

export type ContainerBackend = {
  kind: 'docker' | 'fake'
  ping(): Promise<boolean>
  /** The engine's view of its host (version, OS, CPUs, memory); null when the engine does not answer. */
  info(): Promise<EngineInfo | null>
  /** Creates and starts the container; returns its id. */
  spawnRunner(input: SpawnInput): Promise<string>
  /** Creates and starts a sidecar for a runner; returns its id. Removed with the runner by `removeByRunnerId`. */
  spawnSidecar(input: SidecarInput): Promise<string>
  /** Creates a named volume labelled with the runner's id and host; removed with the runner by `removeByRunnerId`. */
  createVolume(input: VolumeInput): Promise<string>
  /** Every volume labelled with a runner id on this engine. */
  listRunnerVolumes(): Promise<RunnerVolume[]>
  /** Runs a command inside a running container and resolves with its exit code (used to probe a sidecar's readiness). */
  exec(containerId: string, cmd: string[]): Promise<number>
  inspect(containerId: string): Promise<ContainerInfo>
  /** Removes the container (force). Missing containers are not an error. */
  remove(containerId: string): Promise<void>
  /**
   * Removes every container labelled with this runner id (the runner and its sidecars), force, then every volume with
   * that label; nothing found is fine.
   */
  removeByRunnerId(runnerId: number): Promise<void>
  /** Every container labelled `octohatchery.runner=true`, running or exited (sidecars excluded). */
  listOwned(): Promise<ContainerInfo[]>
  /** Every tagged image on the engine (one entry per tag); dangling images are left out. */
  listImages(): Promise<ImageInfo[]>
  /** Pulls an image, resolving once the engine has it; rejects with the engine's reason. */
  pull(reference: string): Promise<void>
  /**
   * Follows stdout and stderr of a running container until it exits; `since` (ISO-8601) skips older output.
   * Returning from the iterator (`break`) stops following. A missing container yields nothing.
   */
  logs(containerId: string, opts?: { since?: string }): AsyncIterable<ContainerLogLine>
}

export type BackendAdapter = { kind: ContainerBackend['kind']; create(): ContainerBackend }

import { config } from '../config'
import { dockerBackend } from './docker'
import { fakeBackend } from './fake'
import type { BackendAdapter, ContainerBackend } from './types'

/** One entry per container backend; a new backend = one file + one line here. */
export const backendAdapters: readonly BackendAdapter[] = [dockerBackend, fakeBackend]

export function backendFor(kind: string): BackendAdapter {
  const adapter = backendAdapters.find((b) => b.kind === kind)
  if (!adapter) throw new Error(`Unknown CONTAINER_BACKEND "${kind}" (known: ${backendAdapters.map((b) => b.kind).join(', ')})`)
  return adapter
}

let current: ContainerBackend | undefined

/** The node's container backend, created from `CONTAINER_BACKEND` on first use. */
export function backend(): ContainerBackend {
  current ??= backendFor(config().backend).create()
  return current
}

/** Tests only. */
export function setBackend(next: ContainerBackend | undefined): void {
  current = next
}

export type { ContainerBackend, ContainerInfo, SpawnInput } from './types'

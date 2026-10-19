import { Elysia } from 'elysia'
import { service } from '../lib/service'

/** 200 with the snapshot when DB and container engine answer; 503 otherwise (same body). */
export const health = new Elysia({ name: 'health' }).get('/health', async ({ set }) => {
  const snapshot = await service.health()
  if (!snapshot.ok) set.status = 503
  return { ...snapshot, message: snapshot.ok ? 'ok' : `${!snapshot.db ? 'database' : 'container engine'} unreachable` }
})

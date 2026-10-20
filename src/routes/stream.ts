import { Elysia } from 'elysia'
import { bus, type BusEvent } from '../lib/bus'
import { sseResponse, streamClients } from './sse'

const EVENTS: readonly BusEvent[] = ['runner', 'job', 'event', 'slot']

export { streamClients }

/**
 * `GET /events/stream`: Server-Sent Events from the bus (`event: <name>\ndata: <json>`).
 * Caps, idle timeout and heartbeat come from `sseResponse`; `log` batches are not forwarded here
 * (they have their own stream per job under `/api/jobs/:id/log/stream`).
 */
export const stream = new Elysia({ name: 'stream' }).get('/events/stream', ({ request, set }) =>
  sseResponse(request, set, ({ send, touch }) => {
    const listeners = EVENTS.map((name) => {
      const fn = (payload: unknown) => {
        send(name, JSON.stringify(payload))
        touch()
      }
      bus.on(name, fn)
      return [name, fn] as const
    })
    return () => {
      for (const [name, fn] of listeners) bus.off(name, fn)
    }
  }),
)

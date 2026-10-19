import { Elysia } from 'elysia'
import { bus, type BusEvent } from '../lib/bus'
import { jsonErr } from '../lib/json'
import { log } from '../lib/log'
import { settings } from '../lib/settings'

const logger = log('http')
const EVENTS: readonly BusEvent[] = ['runner', 'job', 'event', 'slot']
const HEARTBEAT_MS = 25_000

let clients = 0
export function streamClients(): number {
  return clients
}

/**
 * `GET /events/stream`: Server-Sent Events from the bus (`event: <name>\ndata: <json>`).
 * Capped at `sse_max_clients` (503 beyond), closed after `sse_idle_s` without a bus event,
 * a `: ping` comment every 25 s keeps proxies from timing out, every listener is removed on disconnect.
 */
export const stream = new Elysia({ name: 'stream' }).get('/events/stream', async ({ request, set }) => {
  const max = await settings.fetchInt('sse_max_clients', 20)
  if (clients >= max) {
    const { body, status } = jsonErr(`too many stream clients (max ${max})`, 'unavailable', 503)
    set.status = status
    return body
  }
  const idleMs = (await settings.fetchInt('sse_idle_s', 300)) * 1000
  clients++
  const encoder = new TextEncoder()
  let cleanup = () => {}
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          cleanup()
        }
      }
      let idle = setTimeout(() => cleanup(), idleMs)
      const touch = () => {
        clearTimeout(idle)
        idle = setTimeout(() => cleanup(), idleMs)
      }
      const listeners = EVENTS.map((name) => {
        const fn = (payload: unknown) => {
          send(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
          touch()
        }
        bus.on(name, fn)
        return [name, fn] as const
      })
      const heartbeat = setInterval(() => send(': ping\n\n'), HEARTBEAT_MS)
      let done = false
      cleanup = () => {
        if (done) return
        done = true
        clients--
        clearTimeout(idle)
        clearInterval(heartbeat)
        for (const [name, fn] of listeners) bus.off(name, fn)
        request.signal.removeEventListener('abort', cleanup)
        try {
          controller.close()
        } catch {
          // already closed by the client
        }
        logger.debug(`stream client left (${clients} left)`)
      }
      request.signal.addEventListener('abort', cleanup)
      send(`: connected\n\n`)
      logger.debug(`stream client joined (${clients} total)`)
    },
    cancel() {
      cleanup()
    },
  })
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' },
  })
})

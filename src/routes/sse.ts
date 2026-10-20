import { jsonErr } from '../lib/json'
import { log } from '../lib/log'
import { settings } from '../lib/settings'

const logger = log('http')
const HEARTBEAT_MS = 25_000

let clients = 0
/** Open SSE connections on this node (every stream shares the `sse_max_clients` cap). */
export function streamClients(): number {
  return clients
}

export type SseContext = {
  /** `event: <name>\ndata: <data>`; `name` null sends a comment line. */
  send(name: string | null, data: string): void
  /** Resets the idle timer. */
  touch(): void
  /** Ends the response. */
  close(): void
}

type SetLike = { status?: number | string; headers: Record<string, unknown> }

/**
 * One SSE response: capped at `sse_max_clients` (503 beyond), closed after `sse_idle_s` without a
 * `touch`, a `: ping` comment every 25 s keeps proxies from timing out. `start` wires the producer
 * and returns the function that unwires it; it runs exactly once when the client leaves or `close()` is called.
 */
export async function sseResponse(request: Request, set: SetLike, start: (ctx: SseContext) => () => void): Promise<Response | object> {
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
      const write = (chunk: string) => {
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
      const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS)
      let done = false
      let stop = () => {}
      cleanup = () => {
        if (done) return
        done = true
        clients--
        clearTimeout(idle)
        clearInterval(heartbeat)
        stop()
        request.signal.removeEventListener('abort', cleanup)
        try {
          controller.close()
        } catch {
          // already closed by the client
        }
        logger.debug(`stream client left (${clients} left)`)
      }
      request.signal.addEventListener('abort', cleanup)
      write(': connected\n\n')
      stop = start({
        send: (name, data) => write(name === null ? `: ${data}\n\n` : `event: ${name}\ndata: ${data}\n\n`),
        touch,
        close: () => cleanup(),
      })
      logger.debug(`stream client joined (${clients} total)`)
    },
    cancel() {
      cleanup()
    },
  })
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' },
  })
}

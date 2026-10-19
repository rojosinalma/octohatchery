import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { log } from '../lib/log'

const logger = log('mcp')

// Caps for the in-memory session table. A client that goes quiet is dropped after the idle time;
// when the table is full the oldest session makes room. Clients re-initialise on 404 per the MCP spec.
export const MAX_SESSIONS = 64
export const SESSION_IDLE_MS = 30 * 60_000

type Session = { transport: WebStandardStreamableHTTPServerTransport; server: McpServer; lastUsedAt: number }

const sessions = new Map<string, Session>()

const drop = async (id: string, reason: string) => {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  logger.debug(`session ${id} closed (${reason})`)
  await s.server.close().catch(() => undefined)
}

/** Removes idle sessions and, when still full, the least recently used one. */
export const evict = async (now = Date.now()) => {
  for (const [id, s] of sessions) if (now - s.lastUsedAt > SESSION_IDLE_MS) await drop(id, 'idle')
  while (sessions.size >= MAX_SESSIONS) {
    let oldest: [string, Session] | undefined
    for (const entry of sessions) if (!oldest || entry[1].lastUsedAt < oldest[1].lastUsedAt) oldest = entry
    if (!oldest) break
    await drop(oldest[0], 'table full')
  }
}

/** Creates a session-bound transport and connects a fresh server to it. */
export const openSession = async (server: McpServer): Promise<WebStandardStreamableHTTPServerTransport> => {
  await evict()
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, server, lastUsedAt: Date.now() })
      logger.info(`session ${id} opened by ${server.server.getClientVersion()?.name ?? 'unknown'}`)
    },
    onsessionclosed: (id) => drop(id, 'client delete'),
  })
  await server.connect(transport)
  return transport
}

export const getSession = (id: string): WebStandardStreamableHTTPServerTransport | undefined => {
  const s = sessions.get(id)
  if (!s) return undefined
  s.lastUsedAt = Date.now()
  return s.transport
}

export const sessionCount = () => sessions.size

/** Test helper: closes every session. */
export const closeAllSessions = async () => {
  for (const id of [...sessions.keys()]) await drop(id, 'shutdown')
}

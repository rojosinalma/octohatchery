import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { Elysia } from 'elysia'
import { createServer } from './server'
import { getSession, openSession } from './sessions'

const SESSION_HEADER = 'mcp-session-id'

const jsonRpcError = (status: number, code: number, message: string) =>
  Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status })

/** Routes one HTTP request to the right MCP session (Streamable HTTP transport). */
export const handleMcpRequest = async (request: Request): Promise<Response> => {
  const sessionId = request.headers.get(SESSION_HEADER)
  if (sessionId) {
    const transport = getSession(sessionId)
    if (!transport) return jsonRpcError(404, -32001, 'Session not found; send initialize again')
    return transport.handleRequest(request)
  }

  if (request.method !== 'POST') return jsonRpcError(400, -32000, `Bad request: ${SESSION_HEADER} header required`)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonRpcError(400, -32700, 'Parse error: body is not JSON')
  }
  const isInit = Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body)
  if (!isInit) return jsonRpcError(400, -32000, 'Bad request: first request must be initialize')

  const transport = await openSession(createServer())
  return transport.handleRequest(request, { parsedBody: body })
}

/** Elysia plugin: MCP server over Streamable HTTP at `/mcp`. */
export const mcp = new Elysia({ name: 'mcp' }).all('/mcp', ({ request }) => handleMcpRequest(request))

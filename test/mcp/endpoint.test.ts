import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Elysia } from 'elysia'
import { resetService, service, ServiceError } from './mocks'

const { mcp } = await import('../../src/mcp/index')
const { closeAllSessions, sessionCount, MAX_SESSIONS } = await import('../../src/mcp/sessions')

const build = () => new Elysia().use(mcp).listen(0)
let app: ReturnType<typeof build>
let url: string

beforeAll(() => {
  app = build()
  url = `http://127.0.0.1:${app.server!.port}/mcp`
})
afterAll(async () => {
  await closeAllSessions()
  await app.stop()
})
beforeEach(resetService)

const connect = async (name: string) => {
  const client = new Client({ name, version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url))
  await client.connect(transport)
  return { client, transport }
}

const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as Array<{ type: string; text: string }>)[0]!.text

describe('/mcp endpoint', () => {
  test('answers a raw JSON-RPC initialize POST with the server name', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('mcp-session-id')).toBeTruthy()
    const body = await res.text()
    expect(body).toContain('"name":"octohatchery"')
  })

  test('rejects a non-initialize first request and an unknown session', async () => {
    const first = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(first.status).toBe(400)
    const unknown = await fetch(url, { method: 'GET', headers: { 'mcp-session-id': 'nope', accept: 'text/event-stream' } })
    expect(unknown.status).toBe(404)
  })

  test('lists every tool over the protocol', async () => {
    const { client, transport } = await connect('test')
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('adopt_repo')
    expect(tools).toHaveLength(18)
    expect(tools.find((t) => t.name === 'kill')!.annotations?.destructiveHint).toBe(true)
    await transport.terminateSession()
    await client.close()
  })

  test('adopt_repo calls the facade with actor mcp:<client name>', async () => {
    const { client, transport } = await connect('test')
    const result = await client.callTool({ name: 'adopt_repo', arguments: { repo: 'owner/name' } })
    expect(service.adoptRepo).toHaveBeenCalledWith('owner/name', 'mcp:test')
    expect(JSON.parse(text(result))).toMatchObject({ fullName: 'owner/name', adopted: true })
    await transport.terminateSession()
    await client.close()
  })

  test('ServiceError becomes isError with the message', async () => {
    service.kill.mockImplementationOnce(async () => {
      throw new ServiceError('runner 3 not found', 'not_found')
    })
    const { client, transport } = await connect('test')
    const result = await client.callTool({ name: 'kill', arguments: { runner_id: 3 } })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('runner 3 not found')
    await transport.terminateSession()
    await client.close()
  })

  test('invalid arguments are rejected by the server', async () => {
    const { client, transport } = await connect('test')
    const result = await client.callTool({ name: 'kill', arguments: { runner_id: 'three' } })
    expect(result.isError).toBe(true)
    expect(service.kill).not.toHaveBeenCalled()
    await transport.terminateSession()
    await client.close()
  })

  test('session table stays bounded', async () => {
    const opened: Array<{ client: Client; transport: StreamableHTTPClientTransport }> = []
    for (let i = 0; i < MAX_SESSIONS + 5; i++) opened.push(await connect(`bulk-${i}`))
    expect(sessionCount()).toBeLessThanOrEqual(MAX_SESSIONS)
    for (const o of opened) await o.client.close()
    await closeAllSessions()
    expect(sessionCount()).toBe(0)
  })
})

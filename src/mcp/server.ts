import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import pkg from '../../package.json'
import { log } from '../lib/log'
import { ServiceError } from '../lib/types'
import { tools } from './tools/index'

const logger = log('mcp')

/** Builds one MCP server with every tool registered. One instance serves one client session. */
export const createServer = (): McpServer => {
  const server = new McpServer({ name: 'octohatchery', version: pkg.version })
  const actor = () => `mcp:${server.server.getClientVersion()?.name ?? 'unknown'}`

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { destructiveHint: tool.destructive, readOnlyHint: tool.name.startsWith('list_') || tool.name.startsWith('get_') || tool.name === 'health' },
      },
      async (args) => {
        const who = actor()
        try {
          const result = await tool.handler(args, { actor: who })
          logger.info(`${who} ${tool.name} ok`)
          // Tools that produce text (logs) return it verbatim; everything else is JSON.
          return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? null) }] }
        } catch (err) {
          if (err instanceof ServiceError) {
            logger.warn(`${who} ${tool.name} rejected (${err.code}): ${err.message}`)
            return { isError: true, content: [{ type: 'text', text: err.message }] }
          }
          logger.error(`${who} ${tool.name} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
          throw err
        }
      },
    )
  }
  return server
}

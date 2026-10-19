import type { z } from 'zod'
import type { Actor } from '../../lib/types'

/** Context handed to every tool handler by the MCP server. */
export type ToolContext = { actor: Actor }

/** Raw zod shape: the MCP SDK turns it into the tool's JSON schema. */
export type ToolShape = Record<string, z.ZodType>

export type ToolDefinition<Shape extends ToolShape = ToolShape> = {
  name: string
  description: string
  inputSchema: Shape
  /** True when the tool changes or deletes state; surfaced to clients as an annotation. */
  destructive: boolean
  handler: (args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<unknown>
}

/** Identity helper that keeps the handler's argument type inferred from the schema. */
export const defineTool = <Shape extends ToolShape>(tool: ToolDefinition<Shape>): ToolDefinition<Shape> => tool

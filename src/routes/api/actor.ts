/** Who performed an action: the `X-Actor` header (MCP sets `mcp:<client>`) or `user`. */
export function actorOf(headers: Record<string, string | undefined>): string {
  const a = headers['x-actor']?.trim()
  return a && a.length <= 64 ? a : 'user'
}

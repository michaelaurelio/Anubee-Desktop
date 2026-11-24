import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { call, type Conn } from './client.js'
import { resolveApp } from './handshake.js'
import { TOOLS } from './tools.js'

/**
 * Register every TOOLS entry. The connection is resolved lazily per invocation
 * (or taken from `conn` when supplied, e.g. tests) so a tool used before the app
 * is up returns the clear "no running Anubee Desktop" error instead of crashing at launch.
 */
export function buildServer(conn?: Conn | (() => Conn)): McpServer {
  const server = new McpServer({ name: 'anubee', version: '0.1.0' })
  for (const def of TOOLS) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.inputSchema }, async (input: Record<string, unknown>) => {
      try {
        const c = typeof conn === 'function' ? conn() : (conn ?? resolveApp())
        const result = await call(c, def.command, def.mapArgs(input))
        return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }] }
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] }
      }
    })
  }
  return server
}

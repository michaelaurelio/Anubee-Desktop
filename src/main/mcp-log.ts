// MCP action log (audit surface) + per-session device-actions grant.
// Plain module-level singleton, no Electron import. Ring-capped like the
// renderer's log-store.
export interface McpLogEntry {
  at: number
  tool: string
  args: string
  result: 'ok' | 'error'
  detail?: string
}

export const MCP_LOG_CAP = 2000

const buffer: McpLogEntry[] = []
let deviceGranted = false

export function appendMcpLog(e: McpLogEntry): void {
  buffer.push(e)
  if (buffer.length > MCP_LOG_CAP) buffer.shift()
}

export function getMcpLog(): McpLogEntry[] {
  return buffer.slice()
}

export function clearMcpLog(): void {
  buffer.length = 0
}

export function grantDeviceForSession(): void {
  deviceGranted = true
}

export function revokeDeviceGrant(): void {
  deviceGranted = false
}

export function isDeviceGranted(): boolean {
  return deviceGranted
}

// Called when MCP control is toggled off: drop the log and the grant.
export function resetMcpState(): void {
  clearMcpLog()
  revokeDeviceGrant()
}

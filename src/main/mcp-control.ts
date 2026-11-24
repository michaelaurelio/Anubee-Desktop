// MCP control plane lifecycle: token + loopback server + handshake file.
// Electron-free so it can be tested headlessly; index.ts injects everything.
import crypto from 'node:crypto'
import type { CommandMap } from './commands'
import { createControlServer, type ControlServer } from './control-server'
import { removeHandshake, writeHandshake } from './mcp-handshake'
import { getMcpLog, isDeviceGranted, onMcpLog, resetMcpState, type McpLogEntry } from './mcp-log'

// Tier-3 commands that touch the device; gated behind the per-session grant.
export const DEVICE_COMMANDS: ReadonlySet<string> = new Set([
  'capture.preflight', 'capture.start', 'capture.stop',
  'nativelib.startLive', 'nativelib.stopLive', 'nativelib.verify',
  'nativelib.dumpLib', 'nativelib.exportArtifact',
])

// Tier-2 commands that mutate project state (tags, dismissals, rules). After
// one succeeds the renderer is told to reload from disk (see onWrite).
export const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  'tags.save', 'suggest.dismissed.save', 'suggest.confirm', 'suggest.reject', 'rasp.rules.save',
])

export interface McpState {
  on: boolean
  attached: boolean
  granted: boolean
  log: McpLogEntry[]
}

export interface McpControlOpts {
  buildCommandMap: () => CommandMap
  userDataDir: () => string
  emitToRenderer: (channel: string, data?: unknown) => void
  // TODO(Task 12): index.ts replaces this with the renderer mcp:deviceRequest round-trip.
  deviceGate?: (command: string) => Promise<boolean>
  // Called after a Tier-2 write command succeeds via the server.
  onWrite?: (command: string) => void
}

export interface McpControl {
  enable(): Promise<void>
  disable(): Promise<void>
  isOn(): boolean
  getState(): McpState
  // Forward a stream event to SSE subscribers; no-op while off.
  emit(name: string, data?: unknown): void
}

export function createMcpControl(opts: McpControlOpts): McpControl {
  let server: ControlServer | null = null
  let unsubLog: (() => void) | null = null
  let dir = ''

  const getState = (): McpState => {
    const log = getMcpLog()
    // "attached" = at least one client call seen since enable (the server
    // keeps no persistent client connection to count).
    return { on: server !== null, attached: server !== null && log.length > 0, granted: isDeviceGranted(), log }
  }
  const pushState = (): void => opts.emitToRenderer('mcp:state', getState())

  const wrap = (map: CommandMap): CommandMap => {
    const out: CommandMap = {}
    for (const [name, fn] of Object.entries(map)) {
      out[name] = WRITE_COMMANDS.has(name)
        ? async (args?: unknown) => {
            const r = await fn(args)
            try { opts.onWrite?.(name) } catch { /* refresh is best-effort */ }
            return r
          }
        : fn
    }
    return out
  }

  return {
    async enable() {
      if (server) return
      const token = crypto.randomBytes(32).toString('hex')
      const srv = createControlServer({
        commands: wrap(opts.buildCommandMap()),
        token,
        deviceCommands: new Set(DEVICE_COMMANDS),
        deviceGate: opts.deviceGate ?? (async () => false),
      })
      const port = await srv.start()
      dir = opts.userDataDir()
      try {
        writeHandshake(dir, { port, token, pid: process.pid, startedAt: Date.now() })
      } catch (e) {
        await srv.stop()
        throw e
      }
      server = srv
      let first = true
      unsubLog = onMcpLog(entry => {
        opts.emitToRenderer('mcp:log', entry)
        if (first) { first = false; pushState() } // attached flipped
      })
      pushState()
    },
    async disable() {
      const srv = server
      server = null
      unsubLog?.()
      unsubLog = null
      if (srv) await srv.stop()
      removeHandshake(dir || opts.userDataDir())
      resetMcpState()
      pushState()
    },
    isOn: () => server !== null,
    getState,
    emit(name, data) { server?.emit(name, data) },
  }
}

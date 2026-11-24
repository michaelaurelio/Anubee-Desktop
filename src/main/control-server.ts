// Loopback HTTP control server for the MCP bridge. Plain Node, no Electron.
// POST /call { command, args } with header x-anubee-token.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CommandMap } from './commands'
import { appendMcpLog, isDeviceGranted } from './mcp-log'

export interface ControlServerOpts {
  commands: CommandMap
  token: string
  deviceCommands: Set<string>
  deviceGate: (command: string) => Promise<boolean>
}

export interface ControlServer {
  start(): Promise<number>
  stop(): Promise<void>
  emit(name: string, data: unknown): void
}

const MAX_BODY = 1024 * 1024

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(json)
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function createControlServer(opts: ControlServerOpts): ControlServer {
  const server = http.createServer(async (req, res) => {
    // Auth before anything else, including routing.
    if (req.headers['x-anubee-token'] !== opts.token) {
      send(res, 401, { ok: false, error: 'unauthorized' })
      return
    }
    if (req.method !== 'POST' || req.url !== '/call') {
      send(res, 404, { ok: false, error: 'not found' })
      return
    }
    let command = ''
    let args: unknown
    try {
      const parsed = JSON.parse(await readBody(req) || '{}')
      command = typeof parsed?.command === 'string' ? parsed.command : ''
      args = parsed?.args
    } catch (e) {
      send(res, 400, { ok: false, error: `bad request: ${msg(e)}` })
      return
    }
    const log = (result: 'ok' | 'error', detail?: string): void =>
      appendMcpLog({ at: Date.now(), tool: command, args: safeStringify(args), result, detail })

    const fn = Object.prototype.hasOwnProperty.call(opts.commands, command) ? opts.commands[command] : undefined
    if (!fn) {
      log('error', 'unknown command')
      send(res, 200, { ok: false, error: `unknown command: ${command}` })
      return
    }
    try {
      if (opts.deviceCommands.has(command) && !isDeviceGranted() && !(await opts.deviceGate(command))) {
        log('error', 'device action not permitted')
        send(res, 200, { ok: false, error: 'device action not permitted' })
        return
      }
      const result = await fn(args)
      log('ok')
      send(res, 200, { ok: true, result })
    } catch (e) {
      log('error', msg(e))
      send(res, 200, { ok: false, error: msg(e) })
    }
  })

  return {
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
      })
    },
    stop() {
      return new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
    emit() {
      // SSE streaming is added in Task 5.
    },
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return ''
  }
}

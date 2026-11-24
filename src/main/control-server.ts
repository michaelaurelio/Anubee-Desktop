// Loopback HTTP control server for the MCP bridge. Plain Node, no Electron.
// POST /call { command, args } with header x-anubee-token.
import crypto from 'node:crypto'
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

function tokenOk(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== 'string') return false
  const a = Buffer.from(header)
  const b = Buffer.from(token)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function createControlServer(opts: ControlServerOpts): ControlServer {
  if (typeof opts.token !== 'string' || opts.token.length === 0) {
    throw new Error('control server requires a non-empty token')
  }
  const streams = new Map<string, Set<http.ServerResponse>>()

  const server = http.createServer(async (req, res) => {
    // Auth before anything else, including routing.
    if (!tokenOk(req.headers['x-anubee-token'], opts.token)) {
      send(res, 401, { ok: false, error: 'unauthorized' })
      return
    }
    if (req.method === 'GET' && req.url?.startsWith('/stream/')) {
      let name = ''
      try {
        name = decodeURIComponent(req.url.slice('/stream/'.length).split('?')[0])
      } catch {
        // fall through to 404
      }
      if (!name) {
        send(res, 404, { ok: false, error: 'not found' })
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      let set = streams.get(name)
      if (!set) streams.set(name, (set = new Set()))
      set.add(res)
      req.on('close', () => {
        set!.delete(res)
        if (set!.size === 0 && streams.get(name) === set) streams.delete(name)
      })
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
    const log = (result: 'ok' | 'error', detail?: string): void => {
      try {
        appendMcpLog({ at: Date.now(), tool: command, args: safeStringify(args), result, detail })
      } catch {
        // logging must never break the response
      }
    }

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
    emit(name, data) {
      const set = streams.get(name)
      if (!set) return
      const payload = `data: ${JSON.stringify(data)}\n\n`
      for (const res of set) {
        try {
          res.write(payload)
        } catch {
          set.delete(res)
        }
      }
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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveApp } from '../src/handshake.js'
import { call, openStream } from '../src/client.js'

let dir: string
let server: Server
let port: number
let seen: { token?: string; body?: any }
let nextResponse: unknown

function writeHandshake(pid: number, p = port): void {
  writeFileSync(
    join(dir, 'mcp-control.json'),
    JSON.stringify({ port: p, token: 'tok123', pid, startedAt: 1 }),
  )
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'anubee-mcp-'))
  process.env.ANUBEE_DESKTOP_USERDATA = dir
  server = createServer((req, res) => {
    seen.token = req.headers['x-anubee-token'] as string | undefined
    if (req.method === 'GET' && req.url === '/stream/graph') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"n":1}\n\n')
      return
    }
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      seen.body = raw ? JSON.parse(raw) : undefined
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(nextResponse))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  seen = {}
  rmSync(join(dir, 'mcp-control.json'), { force: true })
})

describe('resolveApp', () => {
  it('throws when the handshake is missing', () => {
    expect(() => resolveApp()).toThrow(/no running Anubee Desktop/)
  })
  it('throws when the pid is dead', () => {
    writeHandshake(2 ** 30)
    expect(() => resolveApp()).toThrow(/no running Anubee Desktop/)
  })
  it('returns baseUrl and token for a live pid', () => {
    writeHandshake(process.pid)
    expect(resolveApp()).toEqual({ baseUrl: `http://127.0.0.1:${port}`, token: 'tok123' })
  })
})

describe('call', () => {
  it('sends the token and unwraps result', async () => {
    writeHandshake(process.pid)
    nextResponse = { ok: true, result: [{ runId: 1 }] }
    const out = await call(resolveApp(), 'graph.runs', { a: 1 })
    expect(out).toEqual([{ runId: 1 }])
    expect(seen.token).toBe('tok123')
    expect(seen.body).toEqual({ command: 'graph.runs', args: { a: 1 } })
  })
  it('throws the server error on ok:false', async () => {
    writeHandshake(process.pid)
    nextResponse = { ok: false, error: 'boom' }
    await expect(call(resolveApp(), 'graph.runs')).rejects.toThrow('boom')
  })
})

describe('openStream', () => {
  it('sends the token header and delivers data events', async () => {
    writeHandshake(process.pid)
    const got = await new Promise<unknown>((resolve) => {
      const stop = openStream(resolveApp(), 'graph', (d) => {
        stop()
        resolve(d)
      })
    })
    expect(got).toEqual({ n: 1 })
    expect(seen.token).toBe('tok123')
  })
})

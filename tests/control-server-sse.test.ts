import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { createControlServer } from '../src/main/control-server'

// Resolves with the parsed JSON of the first `data:` line of an SSE stream.
function firstSseEvent(url: string, token = 't'): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { 'x-anubee-token': token } }, (res) => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        buf += c
        const m = buf.match(/^data: (.*)$/m)
        if (m) {
          resolve(JSON.parse(m[1]))
          req.destroy()
        }
      })
    })
    req.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e)
    })
  })
}

const base = { commands: {}, deviceCommands: new Set<string>(), deviceGate: async () => true }

describe('control server SSE', () => {
  it('delivers an emitted event to an SSE subscriber', async () => {
    const srv = createControlServer({ ...base, token: 't' })
    const port = await srv.start()
    const got = firstSseEvent(`http://127.0.0.1:${port}/stream/tracer.lines`)
    setTimeout(() => srv.emit('tracer.lines', ['hello']), 50)
    expect(await got).toEqual(['hello'])
    await srv.stop()
  })

  it('only delivers to subscribers of the same stream name', async () => {
    const srv = createControlServer({ ...base, token: 't' })
    const port = await srv.start()
    const got = firstSseEvent(`http://127.0.0.1:${port}/stream/tracer.phase`)
    setTimeout(() => {
      srv.emit('tracer.lines', ['wrong'])
      srv.emit('tracer.phase', 'right')
    }, 50)
    expect(await got).toBe('right')
    await srv.stop()
  })

  it('rejects a stream request with a wrong token', async () => {
    const srv = createControlServer({ ...base, token: 't' })
    const port = await srv.start()
    const r = await fetch(`http://127.0.0.1:${port}/stream/tracer.lines`, { headers: { 'x-anubee-token': 'x' } })
    expect(r.status).toBe(401)
    await srv.stop()
  })

  it('rejects an unequal-length token and an empty server token', async () => {
    const srv = createControlServer({ ...base, token: 'secret' })
    const port = await srv.start()
    const r = await fetch(`http://127.0.0.1:${port}/call`, { method: 'POST', headers: { 'x-anubee-token': 'sec' }, body: '{}' })
    expect(r.status).toBe(401)
    await srv.stop()
    expect(() => createControlServer({ ...base, token: '' })).toThrow()
    expect(() => createControlServer({ ...base, token: undefined as unknown as string })).toThrow()
  })
})

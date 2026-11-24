import { describe, it, expect } from 'vitest'
import { createControlServer } from '../src/main/control-server'

async function post(url: string, token: string, body: unknown): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'x-anubee-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json()
}

describe('control server', () => {
  it('rejects a wrong token, routes a known command, gates a device command', async () => {
    const commands = {
      'graph.runs': () => [{ runId: 1 }],
      'dump.lib': () => ({ pulled: true }),
      boom: () => {
        throw new Error('kaboom')
      },
    }
    const srv = createControlServer({
      commands,
      token: 'secret',
      deviceCommands: new Set(['dump.lib']),
      deviceGate: async () => false,
    })
    const port = await srv.start()
    const url = `http://127.0.0.1:${port}/call`
    const bad = await fetch(url, { method: 'POST', headers: { 'x-anubee-token': 'nope' }, body: '{}' })
    expect(bad.status).toBe(401)
    const ok = await post(url, 'secret', { command: 'graph.runs' })
    expect(ok).toEqual({ ok: true, result: [{ runId: 1 }] })
    const denied = await post(url, 'secret', { command: 'dump.lib' })
    expect(denied.ok).toBe(false)
    expect((await post(url, 'secret', { command: 'nope' })).ok).toBe(false)
    expect(await post(url, 'secret', { command: 'boom' })).toEqual({ ok: false, error: 'kaboom' })
    await srv.stop()
  })
})

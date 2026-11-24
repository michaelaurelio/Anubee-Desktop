import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCommands } from '../src/main/commands'
import { createMcpControl, WRITE_COMMANDS, DEVICE_COMMANDS } from '../src/main/mcp-control'
import { readHandshake, handshakePath } from '../src/main/mcp-handshake'
import { resetMcpState } from '../src/main/mcp-log'

const dirs: string[] = []
afterEach(() => {
  resetMcpState()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function call(port: number, token: string, command: string, args?: unknown): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${port}/call`, {
    method: 'POST',
    headers: { 'x-anubee-token': token },
    body: JSON.stringify({ command, args }),
  })
  return r.json()
}

function setup(extra: Partial<Parameters<typeof createMcpControl>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-control-'))
  dirs.push(dir)
  const events: Array<[string, unknown]> = []
  const writes: string[] = []
  const ctl = createMcpControl({
    buildCommandMap: () => ({
      'graph.runs': () => [{ runId: 1 }],
      'tags.save': () => 'saved',
      'capture.start': () => 'started',
    }),
    userDataDir: () => dir,
    emitToRenderer: (c, d) => events.push([c, d]),
    onWrite: c => writes.push(c),
    ...extra,
  })
  return { dir, ctl, events, writes }
}

describe('mcp control lifecycle', () => {
  it('enable serves calls + writes handshake; disable removes both', async () => {
    const { dir, ctl, events } = setup()
    expect(ctl.isOn()).toBe(false)
    await ctl.enable()
    expect(ctl.isOn()).toBe(true)
    const hs = readHandshake(dir)!
    expect(hs.pid).toBe(process.pid)
    expect(await call(hs.port, hs.token, 'graph.runs')).toEqual({ ok: true, result: [{ runId: 1 }] })
    expect((await call(hs.port, 'wrong', 'graph.runs')).ok).toBe(false)
    expect(ctl.getState()).toMatchObject({ on: true, attached: true, granted: false })
    expect(ctl.getState().log.length).toBe(1)
    expect(events.some(([c]) => c === 'mcp:log')).toBe(true)
    expect(events.some(([c]) => c === 'mcp:state')).toBe(true)

    await ctl.disable()
    expect(existsSync(handshakePath(dir))).toBe(false)
    expect(ctl.getState()).toMatchObject({ on: false, attached: false, log: [] })
    await expect(call(hs.port, hs.token, 'graph.runs')).rejects.toThrow()
  })

  it('device command is rejected by the stub gate; write command triggers onWrite', async () => {
    const { dir, ctl, writes } = setup()
    await ctl.enable()
    const hs = readHandshake(dir)!
    const dev = await call(hs.port, hs.token, 'capture.start')
    expect(dev.ok).toBe(false)
    expect(await call(hs.port, hs.token, 'tags.save')).toEqual({ ok: true, result: 'saved' })
    expect(writes).toEqual(['tags.save'])
    await ctl.disable()
  })

  it('concurrent enables share one server; disable mid-enable ends off', async () => {
    const { dir, ctl } = setup()
    await Promise.all([ctl.enable(), ctl.enable()])
    const hs = readHandshake(dir)!
    await ctl.enable()
    expect(readHandshake(dir)!.port).toBe(hs.port)
    expect(await call(hs.port, hs.token, 'graph.runs')).toMatchObject({ ok: true })
    await Promise.all([ctl.disable(), ctl.enable(), ctl.disable()])
    expect(ctl.isOn()).toBe(false)
    expect(existsSync(handshakePath(dir))).toBe(false)
    await expect(call(hs.port, hs.token, 'graph.runs')).rejects.toThrow()
  })

  it('emit is a no-op while off and double disable is safe', async () => {
    const { ctl } = setup()
    expect(() => ctl.emit('trace.loaded', {})).not.toThrow()
    await ctl.enable()
    await ctl.disable()
    await ctl.disable()
    expect(ctl.isOn()).toBe(false)
  })

  it('every WRITE/DEVICE command name is a real command key', () => {
    const map = buildCommands({ store: {} as any, runFileOf: () => ({} as any), device: {} as any })
    for (const n of [...WRITE_COMMANDS, ...DEVICE_COMMANDS]) expect(Object.keys(map)).toContain(n)
  })
})

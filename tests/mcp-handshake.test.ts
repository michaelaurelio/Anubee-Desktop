import { describe, it, expect } from 'vitest'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writeHandshake,
  readHandshake,
  handshakePath,
  isHandshakeLive,
} from '../src/main/mcp-handshake'

describe('mcp handshake', () => {
  it('round-trips and writes owner-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hs-'))
    const hs = { port: 51515, token: 't', pid: process.pid, startedAt: 1 }
    writeHandshake(dir, hs)
    expect(readHandshake(dir)).toEqual(hs)
    expect(statSync(handshakePath(dir)).mode & 0o777).toBe(0o600)
    expect(isHandshakeLive(hs)).toBe(true)
    expect(isHandshakeLive({ ...hs, pid: 2 ** 30 })).toBe(false)
  })
})

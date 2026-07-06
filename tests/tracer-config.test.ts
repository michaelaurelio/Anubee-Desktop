import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig } from '../src/main/tracer-config'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ares-cfg-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('tracer-config', () => {
  it('returns defaults when no file exists', () => {
    expect(loadConfig(dir)).toEqual({ aresBinary: '', specsDir: '' })
  })

  it('round-trips a saved config', () => {
    saveConfig(dir, { aresBinary: '/host/build/ares', specsDir: '/host/specs' })
    expect(loadConfig(dir)).toEqual({ aresBinary: '/host/build/ares', specsDir: '/host/specs' })
  })
})

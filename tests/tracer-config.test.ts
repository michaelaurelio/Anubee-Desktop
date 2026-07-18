import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig } from '../src/main/tracer-config'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'anubee-cfg-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('tracer-config', () => {
  it('returns defaults when no file exists', () => {
    expect(loadConfig(dir)).toEqual({ anubeeBinary: '', specsDir: '' })
  })

  it('round-trips a saved config', () => {
    saveConfig(dir, { anubeeBinary: '/host/build/anubee', specsDir: '/host/specs' })
    expect(loadConfig(dir)).toEqual({ anubeeBinary: '/host/build/anubee', specsDir: '/host/specs' })
  })
})

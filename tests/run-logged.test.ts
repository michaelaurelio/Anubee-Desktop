import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runLogged } from '../src/renderer/run-logged'
import { logGetAll, logClear } from '../src/renderer/log-store'

beforeEach(() => logClear())

describe('runLogged', () => {
  it('appends the formatted success entry on resolve', async () => {
    const r = await runLogged('load', () => Promise.resolve(5), n => ({ level: 'success', message: `n=${n}` }))
    expect(r).toBe(5)
    const all = logGetAll()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ level: 'success', label: 'load', message: 'n=5' })
  })

  it('skips the entry when formatSuccess returns null', async () => {
    await runLogged('load', () => Promise.resolve(null), () => null)
    expect(logGetAll()).toHaveLength(0)
  })

  it('appends an error entry and rethrows on rejection', async () => {
    await expect(runLogged('export', () => Promise.reject(new Error('boom')), () => null)).rejects.toThrow('boom')
    const all = logGetAll()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ level: 'error', label: 'export', message: 'boom' })
  })
})

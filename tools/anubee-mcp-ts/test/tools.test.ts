import { describe, expect, it } from 'vitest'
import { TOOLS } from '../src/tools.js'

const COMMANDS = [
  'graph.runs', 'graph.coverage', 'graph.table', 'graph.count', 'graph.eventById', 'graph.recordChain',
  'graph.nodeEvents', 'graph.nodeEventCount', 'graph.slice', 'graph.stackRollup', 'graph.nodeOffsets',
  'graph.highlightSets', 'graph.diffTable', 'graph.diffSlice', 'rasp.suggest', 'rasp.rules.get', 'tags.load',
  'tags.orphans', 'suggest.dismissed.get', 'nativelib.table', 'backtraces',
  'run.loadByPath', 'run.loadCompareByPath', 'tags.save', 'suggest.dismissed.save', 'suggest.confirm',
  'suggest.reject', 'rasp.rules.save', 'rasp.rules.preview', 'findings.export',
  'capture.preflight', 'capture.start', 'capture.stop', 'nativelib.startLive', 'nativelib.stopLive',
  'nativelib.verify', 'nativelib.dumpLib', 'nativelib.exportArtifact',
]

describe('TOOLS', () => {
  it('maps onto exactly the authoritative command set, once each', () => {
    expect(TOOLS.map((t) => t.command).sort()).toEqual([...COMMANDS].sort())
  })
  it('has unique tool names and descriptions', () => {
    const names = TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const t of TOOLS) expect(t.description.length).toBeGreaterThan(10)
  })
  it('device tools state they prompt on the device', () => {
    for (const t of TOOLS.filter((x) => x.command.startsWith('capture.') || x.command.startsWith('nativelib.') && x.command !== 'nativelib.table'))
      expect(t.description.toLowerCase()).toContain('confirmation on the device')
  })
  it('has the key tool names', () => {
    const names = new Set(TOOLS.map((t) => t.name))
    for (const n of ['query', 'confirm_suggestion', 'backtraces', 'start_capture']) expect(names.has(n)).toBe(true)
  })
  it('forwards args through a mock call', async () => {
    const calls: { command: string; args: unknown }[] = []
    const fakeCall = async (command: string, args: unknown) => (calls.push({ command, args }), {})
    const run = (name: string, input: Record<string, unknown>) => {
      const t = TOOLS.find((x) => x.name === name)!
      return fakeCall(t.command, t.mapArgs(input))
    }
    await run('query', { filter: { syscall: 'openat' }, runId: 2 })
    await run('confirm_suggestion', { suggestion: { target: 'sys:openat', category: 'x' }, offset: '0x10' })
    await run('backtraces', { id: 7 })
    expect(calls[0]).toEqual({ command: 'graph.table', args: { filter: { syscall: 'openat' }, page: { limit: 100, offset: 0 }, runId: 2 } })
    expect(calls[1].command).toBe('suggest.confirm')
    expect(calls[1].args).toMatchObject({ suggestion: { target: 'sys:openat' }, offset: '0x10' })
    expect(calls[2]).toEqual({ command: 'backtraces', args: { id: 7 } })
  })
})

import { describe, it, expect } from 'vitest'
import { sentinelAdapter } from '@shared/adapters/sentinel'
import type { DetectorEvent } from '@shared/events'

const detected: DetectorEvent = {
  type: 'sentinel', check_id: 'hook-scan', technique: 'hook/injection',
  result: 'DETECTED', detail: 'check_su+0x3c(BRK)', ts: 1720000000000,
}
const clean: DetectorEvent = {
  type: 'sentinel', check_id: 'root-check', technique: 'root/su',
  result: 'CLEAN', detail: 'no su binary found', ts: 1720000001000,
}

describe('sentinelAdapter', () => {
  it('links a check to the native block whose symbol appears in detail', () => {
    const natIds = ['nat:libexample.so!check_su', 'nat:libc.so!read']
    const { nodes, edges } = sentinelAdapter([detected], natIds)
    expect(nodes).toEqual([
      { id: 'check:hook-scan', kind: 'check', label: 'hook-scan', module: null, count: 1 },
    ])
    expect(edges).toEqual([
      { id: 'nat:libexample.so!check_su=>check:hook-scan',
        source: 'nat:libexample.so!check_su', target: 'check:hook-scan', count: 1, engine: 'sentinel' },
    ])
  })

  it('still creates the check node (with no edge) when no symbol match is found', () => {
    const { nodes, edges } = sentinelAdapter([clean], ['nat:libexample.so!check_su'])
    expect(nodes).toEqual([
      { id: 'check:root-check', kind: 'check', label: 'root-check', module: null, count: 1 },
    ])
    expect(edges).toHaveLength(0)
  })

  it('does not create a duplicate node for the matched nat: id (caller already has it)', () => {
    const { nodes } = sentinelAdapter([detected], ['nat:libexample.so!check_su'])
    expect(nodes.some(n => n.id === 'nat:libexample.so!check_su')).toBe(false)
  })

  it('returns empty for no rows', () => {
    expect(sentinelAdapter([], [])).toEqual({ nodes: [], edges: [] })
  })
})

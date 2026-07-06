import { describe, it, expect } from 'vitest'
import { GRAPH_SLICE_CAP, FLAME_CHAIN_CAP, FLAME_NODE_CAP } from '@shared/caps'

describe('render caps', () => {
  it('are positive integers', () => {
    for (const c of [GRAPH_SLICE_CAP, FLAME_CHAIN_CAP, FLAME_NODE_CAP]) {
      expect(Number.isInteger(c)).toBe(true)
      expect(c).toBeGreaterThan(0)
    }
  })
  it('chain cap bounds the IPC payload above the render node cap', () => {
    // Many chains fold into fewer tree nodes, so the chain cap is the larger guard.
    expect(FLAME_CHAIN_CAP).toBeGreaterThanOrEqual(FLAME_NODE_CAP)
  })
})

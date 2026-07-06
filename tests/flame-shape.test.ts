import { describe, it, expect } from 'vitest'
import { buildFlame, layoutFlame } from '../src/shared/flame-shape'

const SAMPLE = [
  { chain: ['java:com.example.app.RootCheck.run', 'nat:libexample.so!RootCheck_run', 'nat:libexample.so!check_su', 'sys:openat'], count: 2 },
  { chain: ['nat:libc.so!read', 'sys:read'], count: 1 },
]

describe('buildFlame', () => {
  it('sums counts and builds a prefix tree under a synthetic root', () => {
    const t = buildFlame(SAMPLE)
    expect(t.root.kind).toBe('root')
    expect(t.root.value).toBe(3)
    // heaviest child first
    expect(t.root.children.map(c => c.id)).toEqual([
      'java:com.example.app.RootCheck.run', 'nat:libc.so!read',
    ])
    const java = t.root.children[0]
    expect(java.value).toBe(2)
    expect(java.depth).toBe(1)
    expect(java.label).toBe('com.example.app.RootCheck.run')
    // linear chain below java down to the syscall leaf
    expect(java.children[0].id).toBe('nat:libexample.so!RootCheck_run')
    expect(java.children[0].children[0].id).toBe('nat:libexample.so!check_su')
    expect(java.children[0].children[0].children[0].id).toBe('sys:openat')
    expect(java.children[0].children[0].children[0].value).toBe(2)
    expect(t.root.children[1].value).toBe(1) // libc.so!read
    expect(t.nodeCount).toBe(7) // root + 4 (java branch) + 2 (read branch)
    expect(t.truncated).toBe(false)
  })

  it('merges a shared prefix into one branch', () => {
    const t = buildFlame([
      { chain: ['java:A', 'sys:openat'], count: 3 },
      { chain: ['java:A', 'sys:read'], count: 1 },
    ])
    const a = t.root.children[0]
    expect(a.id).toBe('java:A')
    expect(a.value).toBe(4)
    expect(a.children.map(c => c.id)).toEqual(['sys:openat', 'sys:read']) // heaviest first
  })

  it('handles empty input', () => {
    const t = buildFlame([])
    expect(t.root.value).toBe(0)
    expect(t.root.children).toEqual([])
    expect(t.nodeCount).toBe(1)
  })

  it('caps node count and flags truncation', () => {
    const t = buildFlame(SAMPLE, 3) // root + 2 nodes then stop
    expect(t.nodeCount).toBeLessThanOrEqual(3)
    expect(t.truncated).toBe(true)
  })
})

describe('layoutFlame', () => {
  it('lays the root across the full width at the top', () => {
    const t = buildFlame(SAMPLE)
    const rects = layoutFlame(t.root, 600, 20)
    const root = rects.find(r => r.node === t.root)!
    expect(root.x).toBe(0)
    expect(root.w).toBe(600)
    expect(root.y).toBe(0)
  })

  it('partitions a parent width among children by value and steps y by depth', () => {
    const t = buildFlame(SAMPLE) // root.value 3: java=2, read=1
    const rects = layoutFlame(t.root, 600, 20)
    const java = rects.find(r => r.node.id === 'java:com.example.app.RootCheck.run')!
    const read = rects.find(r => r.node.id === 'nat:libc.so!read')!
    expect(java.w).toBeCloseTo(400) // 600 * 2/3
    expect(read.w).toBeCloseTo(200) // 600 * 1/3
    expect(java.x).toBe(0)
    expect(read.x).toBeCloseTo(400)
    expect(java.y).toBe(20) // depth 1
  })
})

import { describe, it, expect } from 'vitest'
import { resolveTagTargets } from '@shared/tag-targets'
import type { Tag } from '@shared/project-store'

const tags: Tag[] = [
  { target: 'sys:openat', category: 'root', source: 'manual', createdAt: '2026-07-20T00:00:00Z' },
  { target: 'nat:libexample.so!checkRoot', category: 'root', source: 'manual', createdAt: '2026-07-20T00:00:00Z' },
  { target: 'java:com.x.Y.isRooted', category: 'debugger', source: 'manual', createdAt: '2026-07-20T00:00:00Z' },
  { target: 'edge:a=>b', category: 'root', source: 'manual', createdAt: '2026-07-20T00:00:00Z' },
  { target: 'fn:libexample.so!x', category: 'root', source: 'manual', createdAt: '2026-07-20T00:00:00Z' },
]

describe('resolveTagTargets', () => {
  it('buckets node targets and ignores edge:/fn:', () => {
    expect(resolveTagTargets(tags)).toEqual({
      syscalls: ['openat'],
      natFrames: ['libexample.so!checkRoot'],
      javaMethods: ['com.x.Y.isRooted'],
    })
  })
  it('scopes to a category when given', () => {
    expect(resolveTagTargets(tags, 'debugger')).toEqual({
      syscalls: [], natFrames: [], javaMethods: ['com.x.Y.isRooted'],
    })
  })
  it('empty tags yield empty buckets', () => {
    expect(resolveTagTargets([])).toEqual({ syscalls: [], natFrames: [], javaMethods: [] })
  })
})

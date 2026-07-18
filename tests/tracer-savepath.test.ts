import { describe, it, expect } from 'vitest'
import { resolveSavePath } from '@shared/tracer-caps'

describe('resolveSavePath', () => {
  it('uses the chosen path when provided', () => {
    expect(resolveSavePath('/home/u/run.jsonl', '/def/anubee-1.jsonl')).toBe('/home/u/run.jsonl')
  })
  it('falls back to the default when chosen is empty/undefined', () => {
    expect(resolveSavePath('', '/def/anubee-1.jsonl')).toBe('/def/anubee-1.jsonl')
    expect(resolveSavePath(undefined, '/def/anubee-1.jsonl')).toBe('/def/anubee-1.jsonl')
  })
})

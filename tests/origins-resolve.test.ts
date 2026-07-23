import { describe, it, expect } from 'vitest'
import { baseKey, resolveHits } from '../src/shared/origins'
import { aggregate, type RawHit } from '../src/shared/rasp-heuristics'

const bases = new Map<string, bigint>([[baseKey(100, 'libsentinel.so'), 0x7000n]])

const hit = (over: Partial<RawHit> = {}): RawHit => ({
  ruleId: 'r', target: 'nat:libsentinel.so!scan', frame: { module: 'libsentinel.so', addr: '0x788c' },
  pid: 100, category: 'hook', confidence: 0.9, rationale: 'maps scan', ...over,
})

describe('resolveHits', () => {
  it('computes the module-relative offset', () => {
    expect(resolveHits([hit()], bases)[0].offset).toBe('0x88c')
  })
  it('reports [unmapped] when the module has no load base', () => {
    expect(resolveHits([hit({ frame: { module: 'libother.so', addr: '0x788c' } })], bases)[0].offset).toBe('[unmapped]')
  })
  it('reports [unmapped] for a java-attributed hit with no frame', () => {
    expect(resolveHits([hit({ frame: null })], bases)[0].offset).toBe('[unmapped]')
  })
  it('reports [unmapped] for an unparseable address', () => {
    expect(resolveHits([hit({ frame: { module: 'libsentinel.so', addr: 'zzz' } })], bases)[0].offset).toBe('[unmapped]')
  })
})

describe('aggregate', () => {
  it('keeps categories on one target apart', () => {
    const rows = resolveHits([hit(), hit({ category: 'root', confidence: 0.85, rationale: 'su path' })], bases)
    const out = aggregate(rows)
    expect(out).toHaveLength(2)
    expect(out.map(s => s.category).sort()).toEqual(['hook', 'root'])
  })
  it('sums occurrences and collects distinct offsets per row', () => {
    const rows = resolveHits([
      hit(), hit(),
      hit({ frame: { module: 'libsentinel.so', addr: '0x7abc' } }),
    ], bases)
    const out = aggregate(rows)
    expect(out).toHaveLength(1)
    expect(out[0].occurrences).toBe(3)
    expect(out[0].offsets).toEqual([{ offset: '0x88c', occurrences: 2 }, { offset: '0xabc', occurrences: 1 }])
  })
})

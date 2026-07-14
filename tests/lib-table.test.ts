import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resolve } from 'node:path'
import { GraphStore } from '../src/main/graph-store'

describe('GraphStore.libTable', () => {
  const store = new GraphStore()
  beforeAll(async () => { await store.ingest(resolve(__dirname, 'fixtures/lib-sample.jsonl')) })
  afterAll(async () => { await store.close() })

  it('returns one row per lib record, first-seen order', async () => {
    const rows = await store.libTable()
    expect(rows.map(r => r.library.split('/').pop())).toEqual(['libc.so', 'libsentinel.so', 'libunmapped.so'])
  })

  it('computes size = end - start and carries soname', async () => {
    const rows = await store.libTable()
    const sentinel = rows.find(r => r.soname === 'libsentinel.so')!
    expect(sentinel.base).toBe('0x7c40e10000')
    expect(sentinel.size).toBe(0x7c40ee0000 - 0x7c40e10000)
    expect(rows[0].soname).toBeNull() // libc has no soname
  })

  it('flags a library unmapped when a matching unlib exists', async () => {
    const rows = await store.libTable()
    expect(rows.find(r => r.library.endsWith('libunmapped.so'))!.unmapped).toBe(true)
    expect(rows.find(r => r.library.endsWith('libsentinel.so'))!.unmapped).toBe(false)
  })
})

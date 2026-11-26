import { describe, it, expect, vi, afterEach } from 'vitest'
import { createViewRequester } from '../src/main/view-request'
import type { RendererView } from '../src/shared/view-snapshot'

const V: RendererView = {
  activeRunId: 1, engine: 'syscall', view: 'graph', compare: null,
  filter: { tid: 42 }, filterText: 'tid:42', graphFilter: null,
  selectedRecordId: null, selectedNode: null, tablePage: { offset: 0, limit: 500 },
}

afterEach(() => vi.useRealTimers())

function setup(ids: string[] = ['id-1', 'id-2']) {
  const sent: string[] = []
  let n = 0
  const r = createViewRequester({ send: id => { sent.push(id); return true }, newId: () => ids[n++] })
  return { r, sent }
}

describe('createViewRequester', () => {
  it('resolves with the view from the matching reply', async () => {
    const { r, sent } = setup()
    const p = r.request()
    r.reply({ id: sent[0], view: V })
    expect(await p).toEqual(V)
  })

  it('rejects immediately when there is no window', async () => {
    const r = createViewRequester({ send: () => false })
    await expect(r.request()).rejects.toThrow('Anubee window not available')
  })

  it('rejects after the timeout', async () => {
    vi.useFakeTimers()
    const { r } = setup()
    const p = r.request()
    const check = expect(p).rejects.toThrow('Anubee window did not answer the view request')
    await vi.advanceTimersByTimeAsync(5000)
    await check
  })

  it('ignores a late reply after timeout', async () => {
    vi.useFakeTimers()
    const { r, sent } = setup()
    const p = r.request().catch(e => e)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p).toBeInstanceOf(Error)
    expect(() => r.reply({ id: sent[0], view: V })).not.toThrow()
  })

  it('ignores an unknown id', async () => {
    const { r, sent } = setup()
    let settled = false
    const p = r.request().finally(() => { settled = true })
    r.reply({ id: 'nope', view: { ...V, activeRunId: 99 } })
    await Promise.resolve()
    expect(settled).toBe(false)
    r.reply({ id: sent[0], view: V })
    expect(await p).toEqual(V)
  })

  it('correlates concurrent requests', async () => {
    const { r } = setup(['a', 'b'])
    const pa = r.request()
    const pb = r.request()
    const VB = { ...V, activeRunId: 2 }
    r.reply({ id: 'b', view: VB })
    r.reply({ id: 'a', view: V })
    expect(await pa).toEqual(V)
    expect(await pb).toEqual(VB)
  })

  it('rejects on a malformed reply', async () => {
    const { r, sent } = setup()
    const p = r.request()
    r.reply({ id: sent[0], view: 'x' })
    await expect(p).rejects.toThrow('malformed view reply')
  })
})

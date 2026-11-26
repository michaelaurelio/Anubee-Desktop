import { describe, it, expect, vi } from 'vitest'
import { buildCommands } from '../src/main/commands'
import type { GraphStore } from '../src/main/graph-store'
import type { RendererView } from '../src/shared/view-snapshot'

const V: RendererView = {
  activeRunId: 3, engine: 'syscall', view: 'graph', compare: null,
  filter: { tid: 42 }, filterText: 'tid:42', graphFilter: { tid: 42 },
  selectedRecordId: 17, selectedNode: { id: 'sys:openat', kind: 'syscall' }, tablePage: { offset: 0, limit: 500 },
}
const store = {} as GraphStore

describe('view.get', () => {
  it('adds the active run file', async () => {
    const cmd = buildCommands({ store, runFileOf: () => ({ file: '/r/run.jsonl' }), view: async () => V })
    expect(await cmd['view.get']()).toEqual({ ...V, activeRunFile: '/r/run.jsonl' })
  })

  it('no run loaded gives a null file without calling runFileOf', async () => {
    const runFileOf = vi.fn(() => ({ file: '/x' }))
    const cmd = buildCommands({ store, runFileOf, view: async () => ({ ...V, activeRunId: null }) })
    expect(await cmd['view.get']()).toMatchObject({ activeRunId: null, activeRunFile: null })
    expect(runFileOf).not.toHaveBeenCalled()
  })

  it('unknown run id gives a null file, not an error', async () => {
    const cmd = buildCommands({ store, runFileOf: () => { throw new Error('unknown runId 3') }, view: async () => V })
    expect(await cmd['view.get']()).toMatchObject({ activeRunId: 3, activeRunFile: null })
  })

  it('propagates the requester error', async () => {
    const cmd = buildCommands({
      store, runFileOf: () => ({ file: '/x' }),
      view: async () => { throw new Error('Anubee window did not answer the view request') },
    })
    await expect(cmd['view.get']()).rejects.toThrow('Anubee window did not answer the view request')
  })

  it('errors when view is not wired', async () => {
    const cmd = buildCommands({ store, runFileOf: () => ({ file: '/x' }) })
    await expect(cmd['view.get']()).rejects.toThrow('view not available')
  })
})

import { describe, it, expect } from 'vitest'
import { buildViewSnapshot, type ViewState } from '../src/renderer/view-snapshot'

const empty: ViewState = {
  engine: 'syscall', view: 'graph', diffMode: 'all', filter: {}, filterText: '',
  graphFilter: {}, graphDrawn: false, tableOffset: 0, tableLimit: 500,
}

describe('buildViewSnapshot', () => {
  it('maps an empty app to nulls', () => {
    expect(buildViewSnapshot(empty)).toEqual({
      activeRunId: null, engine: 'syscall', view: 'graph', compare: null,
      filter: {}, filterText: '', graphFilter: null,
      selectedRecordId: null, selectedNode: null, tablePage: { offset: 0, limit: 500 },
    })
  })

  it('reports compare only when runB is set', () => {
    expect(buildViewSnapshot({ ...empty, runB: 7, diffMode: 'only-in-B' }).compare)
      .toEqual({ runId: 7, diffMode: 'only-in-B' })
  })

  it('reports graphFilter only when a graph is drawn', () => {
    expect(buildViewSnapshot({ ...empty, graphFilter: { tid: 42 } }).graphFilter).toBeNull()
    expect(buildViewSnapshot({ ...empty, graphDrawn: true, graphFilter: { tid: 42 } }).graphFilter).toEqual({ tid: 42 })
  })

  it('drops extra node fields', () => {
    const node = { id: 'sys:openat', kind: 'syscall', cats: ['root'], filter: { tid: 1 } }
    expect(buildViewSnapshot({ ...empty, currentNode: node }).selectedNode).toEqual({ id: 'sys:openat', kind: 'syscall' })
  })

  it('reports the active run and selected record', () => {
    const s = buildViewSnapshot({ ...empty, activeRunId: 3, selectedRowId: 17, tableOffset: 500 })
    expect(s).toMatchObject({ activeRunId: 3, selectedRecordId: 17, tablePage: { offset: 500, limit: 500 } })
  })
})

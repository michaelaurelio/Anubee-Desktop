// Build the MCP view snapshot (get_view) from the renderer's raw state.
// Pure so it can be tested without the app; main.ts feeds it its module state.
import type { Filter } from '@shared/filter'
import type { RendererView } from '@shared/view-snapshot'

export interface ViewState {
  activeRunId?: number
  engine: 'syscall' | 'func'
  view: 'graph' | 'flame' | 'libs'
  runB?: number
  diffMode: 'all' | 'only-in-A' | 'only-in-B' | 'tagged'
  filter: Filter
  filterText: string
  graphFilter: Filter
  graphDrawn: boolean
  selectedRowId?: number
  currentNode?: { id: string; kind?: string }
  tableOffset: number
  tableLimit: number
}

export function buildViewSnapshot(s: ViewState): RendererView {
  return {
    activeRunId: s.activeRunId ?? null,
    engine: s.engine,
    view: s.view,
    compare: s.runB === undefined ? null : { runId: s.runB, diffMode: s.diffMode },
    filter: s.filter,
    filterText: s.filterText,
    graphFilter: s.graphDrawn ? s.graphFilter : null,
    selectedRecordId: s.selectedRowId ?? null,
    selectedNode: s.currentNode ? { id: s.currentNode.id, kind: s.currentNode.kind } : null,
    tablePage: { offset: s.tableOffset, limit: s.tableLimit },
  }
}

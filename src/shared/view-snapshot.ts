// What the user is looking at, as reported to an MCP client on request
// (get_view). Ids only: record contents are fetched separately (get_event).
import type { Filter } from './filter'

export interface RendererView {
  activeRunId: number | null
  engine: 'syscall' | 'func'
  view: 'graph' | 'flame' | 'libs'
  compare: { runId: number; diffMode: 'all' | 'only-in-A' | 'only-in-B' | 'tagged' } | null
  filter: Filter                      // filter the table shows: pass to query/count as-is
  filterText: string                  // the omni bar as typed; may hold edits not yet applied
  graphFilter: Filter | null          // filter the drawn graph used; null if no graph
  selectedRecordId: number | null
  selectedNode: { id: string; kind?: string } | null
  tablePage: { offset: number; limit: number }
}

// Main adds the run file, which only the store knows.
export type ViewSnapshot = RendererView & { activeRunFile: string | null }

export const VIEW_TIMEOUT_MS = 5000

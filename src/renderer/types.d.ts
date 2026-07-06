import type { Filter } from '@shared/filter'
import type { GraphSlice } from '@shared/graph-shape'
import type { TableRow } from '@shared/table'
import type { SyscallEvent } from '@shared/events'

declare global {
  interface Window {
    ares: {
      openFile(): Promise<{ runId: number; eventCount: number; errors: number } | null>
      runs(): Promise<{ runId: number; file: string; ingestedAt: string; eventCount: number }[]>
      table(filter: Filter, page: { limit: number; offset: number }, runId?: number): Promise<TableRow[]>
      slice(filter: Filter, cap?: number, runId?: number): Promise<GraphSlice>
      eventById(id: number, runId?: number): Promise<SyscallEvent | undefined>
      nodeEvents(nodeId: string, filter: Filter, runId?: number): Promise<SyscallEvent[]>
      suggest: (runId?: number) => Promise<import('@shared/rasp-heuristics').Suggestion[]>
      diffTable: (runA: number, runB: number, filter: import('@shared/filter').Filter, cap?: number) =>
        Promise<import('@shared/diff').DiffRow[]>
      diffSlice: (runA: number, runB: number, nodeId: string, filter: Filter) =>
        Promise<import('@shared/diff').MergedSlice>
      loadTags(runId: number): Promise<{ tags: import('@shared/project-store').Tag[]; errors: string[] }>
      saveTags(runId: number, tags: import('@shared/project-store').Tag[]): Promise<void>
      exportFindings: (runId: number, format: 'md' | 'json') => Promise<string | null>
      onProgress(cb: (pct: number) => void): void
      onLoaded(cb: (s: { runId: number; eventCount: number; errors: number }) => void): void
    }
  }
}

export {}

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
      loadTags(runId: number): Promise<{ tags: import('@shared/project-store').Tag[]; errors: string[] }>
      saveTags(runId: number, tags: import('@shared/project-store').Tag[]): Promise<void>
      onProgress(cb: (pct: number) => void): void
      onLoaded(cb: (s: { runId: number; eventCount: number; errors: number }) => void): void
    }
  }
}

export {}

import type { Filter } from '@shared/filter'
import type { GraphSlice } from '@shared/graph-shape'
import type { TableRow } from '@shared/table'
import type { SyscallEvent } from '@shared/events'

declare global {
  interface Window {
    ares: {
      openFile(): Promise<{ eventCount: number; errors: number } | null>
      table(filter: Filter, page: { limit: number; offset: number }): Promise<TableRow[]>
      slice(filter: Filter, cap?: number): Promise<GraphSlice>
      eventById(id: number): Promise<SyscallEvent | undefined>
      onProgress(cb: (pct: number) => void): void
      onLoaded(cb: (s: { eventCount: number; errors: number }) => void): void
    }
  }
}

export {}

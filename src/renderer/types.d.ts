import type { Filter } from '@shared/filter'
import type { GraphSlice } from '@shared/graph-shape'
import type { StackRollup } from '@shared/flame-shape'
import type { TableRow } from '@shared/table'
import type { SyscallEvent } from '@shared/events'

declare global {
  interface Window {
    ares: {
      openFile(): Promise<{ runId: number; eventCount: number; errors: number } | null>
      runs(): Promise<{ runId: number; file: string; ingestedAt: string; eventCount: number }[]>
      table(filter: Filter, page: { limit: number; offset: number }, runId?: number): Promise<TableRow[]>
      slice(filter: Filter, cap?: number, runId?: number): Promise<GraphSlice>
      stackRollup(filter: Filter, maxChains?: number, runId?: number): Promise<StackRollup>
      eventById(id: number, runId?: number): Promise<SyscallEvent | undefined>
      nodeEvents(nodeId: string, filter: Filter, runId?: number): Promise<SyscallEvent[]>
      suggest: (runId?: number) => Promise<import('@shared/rasp-heuristics').Suggestion[]>
      rulesGet(runId?: number): Promise<{
        builtin: import('@shared/rasp-heuristics').Rule[]
        global: import('@shared/rasp-heuristics').RuleScope
        project: import('@shared/rasp-heuristics').RuleScope
        effective: import('@shared/rasp-heuristics').Rule[]
      }>
      rulesSave(scope: 'global' | 'project', ruleScope: import('@shared/rasp-heuristics').RuleScope, runId?: number): Promise<void>
      rulesPreview(rule: import('@shared/rasp-heuristics').Rule, runId?: number):
        Promise<{ events: number; targets: number } | { error: string }>
      diffTable: (runA: number, runB: number, filter: import('@shared/filter').Filter, cap?: number) =>
        Promise<import('@shared/diff').DiffRow[]>
      diffSlice: (runA: number, runB: number, nodeId: string, filter: Filter) =>
        Promise<import('@shared/diff').MergedSlice>
      loadTags(runId: number): Promise<{ tags: import('@shared/project-store').Tag[]; errors: string[] }>
      saveTags(runId: number, tags: import('@shared/project-store').Tag[]): Promise<void>
      orphans(runId: number, targets: string[]): Promise<string[]>
      exportFindings: (runId: number, format: 'md' | 'json') => Promise<string | null>
      onProgress(cb: (pct: number) => void): void
      onLoaded(cb: (s: { runId: number; eventCount: number; errors: number }) => void): void
      getTracerConfig(): Promise<{ aresBinary: string; specsDir: string }>
      setTracerConfig(cfg: { aresBinary: string; specsDir: string }): Promise<void>
      tracerPreflight(pkg: string): Promise<{ id: string; label: string; ok: boolean; detail: string }[]>
      tracerStart(capId: string, vals: Record<string, unknown>, timeoutSecs?: number):
        Promise<{ code: number; kind: string; runId?: number }>
      tracerStop(): Promise<void>
      onTracerLine(cb: (line: string) => void): void
      onTracerDone(cb: (r: { code: number; kind: string; runId?: number }) => void): void
    }
  }
}

export {}

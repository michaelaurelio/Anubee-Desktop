import type { Filter } from '@shared/filter'
import type { GraphSlice, HighlightSets } from '@shared/graph-shape'
import type { StackRollup } from '@shared/flame-shape'
import type { TableRow } from '@shared/table'
import type { SyscallEvent, CoverageEvent, FuncEvent } from '@shared/events'

declare global {
  interface Window {
    anubee: {
      openFile(): Promise<{ runId: number; eventCount: number; errors: number } | null>
      openFileForCompare(): Promise<{ runId: number; eventCount: number; errors: number } | null>
      saveProject(runId: number, layout?: unknown): Promise<{ path?: string; canceled?: boolean; error?: string }>
      openProject(): Promise<{
        summary?: { runId: number; eventCount: number; errors: number; kinds: ('syscall' | 'funcs')[] }
        layout?: unknown
        canceled?: boolean
        error?: string
      }>
      quit(): Promise<void>
      requestClose(): void
      onConfirmClose(cb: () => void): void
      respondClose(action: 'close' | 'cancel'): void
      copyToClipboard(text: string): Promise<void>
      runs(): Promise<{ runId: number; file: string; ingestedAt: string; eventCount: number }[]>
      table(filter: Filter, page: { limit: number; offset: number }, runId?: number): Promise<TableRow[]>
      count(filter: Filter, runId?: number): Promise<number>
      slice(filter: Filter, cap?: number, runId?: number): Promise<GraphSlice>
      stackRollup(filter: Filter, maxChains?: number, runId?: number): Promise<StackRollup>
      eventById(id: number, runId?: number): Promise<SyscallEvent | FuncEvent | undefined>
      coverage(runId?: number): Promise<CoverageEvent | undefined>
      nodeEvents(nodeId: string, filter: Filter, runId?: number): Promise<(SyscallEvent | FuncEvent)[]>
      highlightSets(nodeId: string, filter: Filter, runId?: number): Promise<HighlightSets>
      nodeOffsets(nodeId: string, filter: Filter, runId?: number): Promise<import('@shared/origins').OffsetRow[]>
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
      dismissedGet(runId: number): Promise<import('@shared/project-store').Dismissed[]>
      dismissedSave(runId: number, dismissed: import('@shared/project-store').Dismissed[]): Promise<void>
      orphans(runId: number, targets: string[]): Promise<string[]>
      exportFindings: (runId: number, format: 'md' | 'json') => Promise<string | null>
      logSave(text: string): Promise<string | null>
      onProgress(cb: (pct: number) => void): void
      onLoaded(cb: (s: { runId: number; eventCount: number; errors: number; kinds: ('syscall' | 'funcs')[] }) => void): void
      getTracerConfig(): Promise<{ anubeeBinary: string; specsDir: string }>
      setTracerConfig(cfg: { anubeeBinary: string; specsDir: string }): Promise<void>
      tracerPreflight(pkg: string): Promise<{ id: string; label: string; ok: boolean; detail: string }[]>
      tracerStart(capId: string, vals: Record<string, unknown>, timeoutSecs?: number, savePath?: string):
        Promise<{ code: number; kind: string; runId?: number }>
      tracerStop(): Promise<void>
      pickSavePath(): Promise<string | undefined>
      tracerCheckPaths(binaryPath: string, specsDir: string): Promise<{
        binary: { ok: boolean; detail: string }
        specs: { ok: boolean; detail: string }
      }>
      tracerListSpecs(specsDir: string): Promise<string[]>
      tracerPickBinary(): Promise<string | undefined>
      tracerPickSpecsDir(): Promise<string | undefined>
      onTracerLine(cb: (line: string) => void): void
      onPreflightCheck(cb: (c: { id: string; label: string; ok: boolean; detail: string }) => void): void
      libTable(runId?: number): Promise<import('@shared/native-lib').LibRow[]>
      startLive(pkg: string, glob?: string): Promise<void>
      stopLive(): Promise<void>
      dumpLib(pid: number, base: string): Promise<import('@shared/native-lib').Artifact[]>
      verify(pid: number, bases: string[]): Promise<void>
      revealArtifact(path: string): Promise<void>
      exportArtifact(path: string): Promise<{ saved: boolean; path?: string }>
      onLibMapped(cb: (l: import('@shared/native-lib').LibLine & { atMs: number }) => void): void
      onLibUnmapped(cb: (l: import('@shared/native-lib').LibLine & { atMs: number }) => void): void
      onLibLine(cb: (line: string) => void): void
      onWatchLine(cb: (line: string) => void): void
      onWatchArtifacts(cb: (a: import('@shared/native-lib').Artifact[]) => void): void
      onLibStreamEnd(cb: () => void): void
      onCheckResults(cb: (results: import('@shared/native-lib').Modcmp[], atMs: number) => void): void
    }
  }
}

export {}

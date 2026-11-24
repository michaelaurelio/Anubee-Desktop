import type { GraphStore } from './graph-store'
import type { Filter } from '@shared/filter'
import { loadTags, loadSidecarRules, loadDismissed } from './sidecar'
import { loadRules } from './rasp-rules-store'
import { resolveRules, BUILTIN_RULES } from '@shared/rasp-heuristics'

export type CommandMap = Record<string, (args?: any) => unknown | Promise<unknown>>

export interface CommandCtx {
  store: GraphStore
  runFileOf(runId: number): { file: string }
  /** Directory holding global rule files (electron userData). Only needed by rasp.* commands. */
  userDataDir?: () => string
}

type Page = { limit: number; offset: number }

export function buildCommands(ctx: CommandCtx): CommandMap {
  const { store } = ctx
  const userData = (): string => {
    if (!ctx.userDataDir) throw new Error('userDataDir not available')
    return ctx.userDataDir()
  }
  return {
    'graph.runs': () => store.runs(),
    'graph.table': ({ filter, page, runId }: { filter: Filter; page: Page; runId?: number }) => store.table(filter, page, runId),
    'graph.count': ({ filter, runId }: { filter: Filter; runId?: number }) => store.count(filter, runId),
    'graph.slice': ({ filter, cap, runId }: { filter: Filter; cap?: number; runId?: number }) => store.slice(filter, cap, runId),
    'graph.stackRollup': ({ filter, maxChains, runId }: { filter: Filter; maxChains?: number; runId?: number }) =>
      store.stackRollup(filter, maxChains, runId),
    'graph.eventById': ({ id, runId }: { id: number; runId?: number }) => store.eventById(id, runId),
    'graph.coverage': ({ runId }: { runId?: number } = {}) => store.coverage(runId),
    'graph.nodeEvents': ({ nodeId, filter, page, runId }: { nodeId: string; filter: Filter; page: Page; runId?: number }) =>
      store.nodeEvents(nodeId, filter, page.limit, runId, page.offset),
    'graph.nodeEventCount': ({ nodeId, filter, runId }: { nodeId: string; filter: Filter; runId?: number }) =>
      store.nodeEventCount(nodeId, filter, runId),
    'graph.highlightSets': ({ nodeId, filter, runId }: { nodeId: string; filter: Filter; runId?: number }) =>
      store.highlightSets(nodeId, filter, runId),
    'graph.recordChain': ({ id, runId }: { id: number; runId?: number }) => store.recordChain(id, runId),
    'graph.nodeOffsets': ({ nodeId, filter, runId }: { nodeId: string; filter: Filter; runId?: number }) =>
      store.nodeOffsets(nodeId, filter, runId),
    'graph.diffTable': ({ runA, runB, filter, cap }: { runA: number; runB: number; filter: Filter; cap?: number }) =>
      store.diffTable(runA, runB, filter, cap),
    'graph.diffSlice': ({ runA, runB, nodeId, filter }: { runA: number; runB: number; nodeId: string; filter: Filter }) =>
      store.diffSlice(runA, runB, nodeId, filter),
    'rasp.suggest': ({ runId }: { runId?: number } = {}) => {
      const rid = runId ?? store.runs().at(-1)?.runId
      if (rid === undefined) return []
      const global = loadRules(userData())
      const project = loadSidecarRules(ctx.runFileOf(rid).file)
      const effective = resolveRules(BUILTIN_RULES, global, project)
      return store.suggest(rid, effective)
    },
    'rasp.rules.get': ({ runId }: { runId?: number } = {}) => {
      const rid = runId ?? store.runs().at(-1)?.runId
      const global = loadRules(userData())
      const project = rid !== undefined
        ? loadSidecarRules(ctx.runFileOf(rid).file)
        : { rules: [], enabledOverrides: {} }
      const effective = resolveRules(BUILTIN_RULES, global, project)
      return { builtin: BUILTIN_RULES, global, project, effective }
    },
    'tags.load': ({ runId }: { runId: number }) => loadTags(ctx.runFileOf(runId).file),
    'tags.orphans': ({ runId, targets }: { runId: number; targets: string[] }) => store.orphanTargets(targets, runId),
    'suggest.dismissed.get': ({ runId }: { runId: number }) => loadDismissed(ctx.runFileOf(runId).file),
    'nativelib.table': ({ runId }: { runId?: number } = {}) => store.libTable(runId),
  }
}

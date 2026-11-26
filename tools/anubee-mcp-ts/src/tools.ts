import { z } from 'zod'

export interface ToolDef {
  name: string
  command: string
  description: string
  /** zod raw shape (property name -> schema), as accepted by McpServer.registerTool. */
  inputSchema: z.ZodRawShape
  mapArgs(input: Record<string, unknown>): unknown
}

// Mirrors the app's Filter (src/shared/filter.ts) without importing it (electron-free).
const filter = z
  .object({
    syscall: z.string().optional(),
    tid: z.number().optional(),
    hasJavaStack: z.boolean().optional(),
    library: z.string().optional(),
    module: z.string().optional(),
    symbol: z.string().optional(),
    text: z.string().optional(),
    id: z.number().optional(),
    idMax: z.number().optional(),
    javaMethod: z.string().optional(),
    stackSymbol: z.string().optional(),
    tagged: z.enum(['yes', 'no']).optional(),
    tagName: z.string().optional(),
    tagTargets: z.object({ syscalls: z.array(z.string()), natFrames: z.array(z.string()), javaMethods: z.array(z.string()) }).optional(),
  })
  .describe('Event filter; all present fields AND together. Empty object matches everything.')

const runId = z.number().int().optional().describe('Run id; defaults to the active run.')
const nodeId = z.string().describe('Graph node id, e.g. "sys:openat", "nat:libc.so!open", "java:com.foo.Bar.baz".')
const category = z.string()
const suggestion = z
  .object({ target: z.string(), category })
  .passthrough()
  .describe('A suggestion as returned by rasp_suggest.')
const tag = z
  .object({ target: z.string(), category, source: z.enum(['manual', 'heuristic']), createdAt: z.string() })
  .passthrough()
const dismissed = z.object({ target: z.string(), category, offset: z.string().optional() })
const rule = z.object({}).passthrough().describe('A RASP rule object.')

const DEVICE = ' This is a device action: it prompts for confirmation on the device (the Anubee Desktop window) before it runs.'

const pageShape = {
  limit: z.number().int().positive().optional().describe('Page size (default 100).'),
  offset: z.number().int().nonnegative().optional().describe('Row offset (default 0).'),
}
const page = (i: Record<string, unknown>) => ({ limit: (i.limit as number) ?? 100, offset: (i.offset as number) ?? 0 })
const f = (i: Record<string, unknown>) => (i.filter as object | undefined) ?? {}

export const TOOLS: ToolDef[] = [
  // ---- reads ----
  { name: 'list_runs', command: 'graph.runs', description: 'List loaded runs with event counts.', inputSchema: {}, mapArgs: () => undefined },
  {
    name: 'coverage', command: 'graph.coverage', description: 'Coverage summary for a run.',
    inputSchema: { runId }, mapArgs: (i) => ({ runId: i.runId }),
  },
  {
    name: 'query', command: 'graph.table', description: 'Page through syscall/function events matching a filter.',
    inputSchema: { filter: filter.optional(), ...pageShape, runId },
    mapArgs: (i) => ({ filter: f(i), page: page(i), runId: i.runId }),
  },
  {
    name: 'count', command: 'graph.count', description: 'Count events matching a filter.',
    inputSchema: { filter: filter.optional(), runId }, mapArgs: (i) => ({ filter: f(i), runId: i.runId }),
  },
  {
    name: 'get_event', command: 'graph.eventById', description: 'Fetch one event by id.',
    inputSchema: { id: z.number().int(), runId }, mapArgs: (i) => ({ id: i.id, runId: i.runId }),
  },
  {
    name: 'record_chain', command: 'graph.recordChain', description: 'Fetch the record chain around an event id.',
    inputSchema: { id: z.number().int(), runId }, mapArgs: (i) => ({ id: i.id, runId: i.runId }),
  },
  {
    name: 'node_events', command: 'graph.nodeEvents', description: 'Page through the events behind a graph node.',
    inputSchema: { nodeId, filter: filter.optional(), ...pageShape, runId },
    mapArgs: (i) => ({ nodeId: i.nodeId, filter: f(i), page: page(i), runId: i.runId }),
  },
  {
    name: 'node_event_count', command: 'graph.nodeEventCount', description: 'Count the events behind a graph node.',
    inputSchema: { nodeId, filter: filter.optional(), runId },
    mapArgs: (i) => ({ nodeId: i.nodeId, filter: f(i), runId: i.runId }),
  },
  {
    name: 'graph_slice', command: 'graph.slice', description: 'Graph slice (nodes and edges) for a filter.',
    inputSchema: { filter: filter.optional(), cap: z.number().int().positive().optional(), runId },
    mapArgs: (i) => ({ filter: f(i), cap: i.cap, runId: i.runId }),
  },
  {
    name: 'stack_rollup', command: 'graph.stackRollup', description: 'Rolled-up call stacks for a filter.',
    inputSchema: { filter: filter.optional(), maxChains: z.number().int().positive().optional(), runId },
    mapArgs: (i) => ({ filter: f(i), maxChains: i.maxChains, runId: i.runId }),
  },
  {
    name: 'node_offsets', command: 'graph.nodeOffsets', description: 'Module-relative call-site offsets for a graph node.',
    inputSchema: { nodeId, filter: filter.optional(), runId },
    mapArgs: (i) => ({ nodeId: i.nodeId, filter: f(i), runId: i.runId }),
  },
  {
    name: 'highlight_sets', command: 'graph.highlightSets', description: 'Node/edge highlight sets for a graph node.',
    inputSchema: { nodeId, filter: filter.optional(), runId },
    mapArgs: (i) => ({ nodeId: i.nodeId, filter: f(i), runId: i.runId }),
  },
  {
    name: 'diff_table', command: 'graph.diffTable', description: 'Diff two runs as a table.',
    inputSchema: { runA: z.number().int(), runB: z.number().int(), filter: filter.optional(), cap: z.number().int().positive().optional() },
    mapArgs: (i) => ({ runA: i.runA, runB: i.runB, filter: f(i), cap: i.cap }),
  },
  {
    name: 'diff_slice', command: 'graph.diffSlice', description: 'Diff two runs for one graph node.',
    inputSchema: { runA: z.number().int(), runB: z.number().int(), nodeId, filter: filter.optional() },
    mapArgs: (i) => ({ runA: i.runA, runB: i.runB, nodeId: i.nodeId, filter: f(i) }),
  },
  {
    name: 'rasp_suggest', command: 'rasp.suggest', description: 'RASP/anti-tamper suggestions for a run, from the effective rules.',
    inputSchema: { runId }, mapArgs: (i) => ({ runId: i.runId }),
  },
  {
    name: 'rasp_rules_get', command: 'rasp.rules.get', description: 'Builtin, global, project and effective RASP rules.',
    inputSchema: { runId }, mapArgs: (i) => ({ runId: i.runId }),
  },
  {
    name: 'tags_load', command: 'tags.load', description: 'Load the saved tags for a run.',
    inputSchema: { runId: z.number().int() }, mapArgs: (i) => ({ runId: i.runId }),
  },
  {
    name: 'tags_orphans', command: 'tags.orphans', description: 'Which tag targets no longer exist in a run.',
    inputSchema: { runId: z.number().int(), targets: z.array(z.string()) },
    mapArgs: (i) => ({ runId: i.runId, targets: i.targets }),
  },
  {
    name: 'dismissed_get', command: 'suggest.dismissed.get', description: 'Load dismissed suggestions for a run.',
    inputSchema: { runId: z.number().int() }, mapArgs: (i) => ({ runId: i.runId }),
  },
  {
    name: 'native_libs', command: 'nativelib.table', description: 'Table of native libraries seen in a run.',
    inputSchema: { runId }, mapArgs: (i) => ({ runId: i.runId }),
  },
  {
    name: 'backtraces', command: 'backtraces',
    description: 'Resolved backtrace frames (module, symbol, load base, module-relative offset) for an event id or a node id.',
    inputSchema: { id: z.number().int().optional(), nodeId: z.string().optional(), runId },
    mapArgs: (i) => ({ id: i.id, nodeId: i.nodeId, runId: i.runId }),
  },
  {
    name: 'get_view', command: 'view.get',
    description:
      'What the user is looking at in Anubee Desktop right now: active run (activeRunId, activeRunFile), engine, open tab, ' +
      'compare run and diff mode, the toolbar filter (filter, plus filterText as shown), the filter the on-screen graph was ' +
      'drawn with (graphFilter; can differ from filter because the graph redraws only on row selection), the selected record ' +
      'id and graph node, and the table page. Pass filter with runId: activeRunId straight to query or count to work on the ' +
      "records the user narrowed down. Use get_event for a record's contents.",
    inputSchema: {}, mapArgs: () => undefined,
  },

  // ---- writes ----
  {
    name: 'load_run', command: 'run.loadByPath', description: 'Load a run file by path as the primary run.',
    inputSchema: { path: z.string() }, mapArgs: (i) => ({ path: i.path }),
  },
  {
    name: 'load_compare_run', command: 'run.loadCompareByPath', description: 'Load a run file by path as a comparison run (primary stays active).',
    inputSchema: { path: z.string() }, mapArgs: (i) => ({ path: i.path }),
  },
  {
    name: 'tags_save', command: 'tags.save', description: 'Replace the saved tags for a run.',
    inputSchema: { tags: z.array(tag), runId }, mapArgs: (i) => ({ runId: i.runId, tags: i.tags }),
  },
  {
    name: 'dismissed_save', command: 'suggest.dismissed.save', description: 'Replace the dismissed suggestions for a run.',
    inputSchema: { dismissed: z.array(dismissed), runId }, mapArgs: (i) => ({ runId: i.runId, dismissed: i.dismissed }),
  },
  {
    name: 'confirm_suggestion', command: 'suggest.confirm', description: 'Confirm a suggestion: mints a tag from it and saves it.',
    inputSchema: { suggestion, offset: z.string().optional(), runId },
    mapArgs: (i) => ({ runId: i.runId, suggestion: i.suggestion, offset: i.offset }),
  },
  {
    name: 'reject_suggestion', command: 'suggest.reject', description: 'Reject (dismiss) a suggestion.',
    inputSchema: { suggestion: z.object({ target: z.string(), category }).passthrough(), offset: z.string().optional(), runId },
    mapArgs: (i) => ({ runId: i.runId, suggestion: i.suggestion, offset: i.offset }),
  },
  {
    name: 'rasp_rules_save', command: 'rasp.rules.save', description: 'Save a RASP rule scope (rules plus enabled overrides) at global or project level.',
    inputSchema: {
      scope: z.enum(['global', 'project']),
      ruleScope: z.object({ rules: z.array(rule), enabledOverrides: z.record(z.string(), z.boolean()) }),
      runId,
    },
    mapArgs: (i) => ({ scope: i.scope, ruleScope: i.ruleScope, runId: i.runId }),
  },
  {
    name: 'rasp_rules_preview', command: 'rasp.rules.preview', description: 'Preview what a candidate RASP rule would match in a run.',
    inputSchema: { rule, runId }, mapArgs: (i) => ({ rule: i.rule, runId: i.runId }),
  },
  {
    name: 'export_findings', command: 'findings.export', description: 'Export findings from the saved tags to an explicit file path (md or json).',
    inputSchema: { format: z.enum(['md', 'json']), path: z.string(), overwrite: z.boolean().optional(), runId },
    mapArgs: (i) => ({ runId: i.runId, format: i.format, path: i.path, overwrite: i.overwrite }),
  },

  // ---- device (confirmation on the device) ----
  {
    name: 'preflight_capture', command: 'capture.preflight', description: 'Preflight checks for capturing a package.' + DEVICE,
    inputSchema: { pkg: z.string() }, mapArgs: (i) => ({ pkg: i.pkg }),
  },
  {
    name: 'start_capture', command: 'capture.start', description: 'Start a capture on the device.' + DEVICE,
    inputSchema: {
      capId: z.string(), vals: z.record(z.string(), z.unknown()).optional(),
      timeoutSecs: z.number().positive().optional(), savePath: z.string().optional(),
    },
    mapArgs: (i) => ({ capId: i.capId, vals: i.vals ?? {}, timeoutSecs: i.timeoutSecs, savePath: i.savePath }),
  },
  {
    name: 'stop_capture', command: 'capture.stop', description: 'Stop the running capture.' + DEVICE,
    inputSchema: { discard: z.boolean().optional() }, mapArgs: (i) => ({ discard: i.discard }),
  },
  {
    name: 'start_live_libs', command: 'nativelib.startLive', description: 'Start live native-library watching for a package.' + DEVICE,
    inputSchema: { pkg: z.string(), glob: z.string().optional() }, mapArgs: (i) => ({ pkg: i.pkg, glob: i.glob }),
  },
  {
    name: 'stop_live_libs', command: 'nativelib.stopLive', description: 'Stop live native-library watching.' + DEVICE,
    inputSchema: {}, mapArgs: () => undefined,
  },
  {
    name: 'verify_libs', command: 'nativelib.verify', description: 'Verify native library load bases in a process.' + DEVICE,
    inputSchema: { pid: z.number().int(), bases: z.array(z.string()) }, mapArgs: (i) => ({ pid: i.pid, bases: i.bases }),
  },
  {
    name: 'dump_lib', command: 'nativelib.dumpLib', description: 'Dump a loaded native library from process memory.' + DEVICE,
    inputSchema: { pid: z.number().int(), base: z.string() }, mapArgs: (i) => ({ pid: i.pid, base: i.base }),
  },
  {
    name: 'export_lib_artifact', command: 'nativelib.exportArtifact', description: 'Export a pulled library artifact to an explicit destination path.' + DEVICE,
    inputSchema: { path: z.string(), dest: z.string(), overwrite: z.boolean().optional() }, mapArgs: (i) => ({ path: i.path, dest: i.dest, overwrite: i.overwrite }),
  },
]

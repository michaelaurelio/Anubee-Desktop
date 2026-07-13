import { openSync, readSync, closeSync, existsSync } from 'node:fs'
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api'
import type { SyscallEvent, CoverageEvent, FuncEvent } from '@shared/events'
import { filterToSql, type Filter } from '@shared/filter'
import { capSlice, labelForId, mergeGraphs, type GraphNode, type GraphEdge, type GraphSlice } from '@shared/graph-shape'
import type { TableRow } from '@shared/table'
import type { StackRollup } from '@shared/flame-shape'
import { compileWhere, scoreWith, aggregate, resolveRules, BUILTIN_RULES, type Rule, type RuleScope, type Suggestion } from '@shared/rasp-heuristics'
import { presenceOf, type DiffRow, type MergedSlice, type MergedNode } from '@shared/diff'
import { parseHexAddr, moduleRelative, type OffsetRow } from '@shared/origins'
import { parseFrameSymbol } from '@shared/frame-symbol'

export type { TableRow }

// Explicit read_json schema so DuckDB never mis-infers the nested/heterogeneous
// fields. Extends the ARES host store's schema (tools/ares-mcp/trace_store.py)
// with `type`, `stack_id`, and `java_stack` - the last is the RASP bridge this
// app is built around. `type` also lets ingest separate a malformed line
// (all-null row → type NULL) from a valid non-syscall record (type='lib').
//
// EPIC A: widened with the funcs/coverage fields (all nullable - syscall rows
// leave them null, and vice versa). `span` is kept as the disambiguator the
// `span IS NULL` guard on every syscall/funcs-only query below relies on.
const COLS =
  "{'type':'VARCHAR','id':'BIGINT','pid':'INTEGER','tid':'INTEGER'," +
  "'syscall_nr':'BIGINT','syscall':'VARCHAR','args':'VARCHAR[]','retval':'BIGINT'," +
  "'string_args':'MAP(VARCHAR,VARCHAR)','fd_args':'MAP(VARCHAR,VARCHAR)'," +
  "'decoded_args':'MAP(VARCHAR,VARCHAR)','sock_addr':'VARCHAR','stack_id':'VARCHAR'," +
  "'java_stack':'VARCHAR[]'," +
  "'library':'VARCHAR','start':'VARCHAR','end':'VARCHAR','pgoff':'BIGINT'," +
  "'backtrace':'STRUCT(frame INTEGER, addr VARCHAR, symbol VARCHAR)[]'," +
  "'cfi_backtrace':'STRUCT(frame INTEGER, addr VARCHAR, symbol VARCHAR, kind VARCHAR)[]'," +
  // 'engine' is CoverageEvent's own field (e.g. "type":"coverage","engine":"funcs");
  // coverage() round-trips it, so it stays in the schema.
  "'engine':'VARCHAR'," +
  "'span':'BIGINT','entry_addr':'VARCHAR','elapsed_ns':'BIGINT','symbol':'VARCHAR','module':'VARCHAR'," +
  "'sock_args':'MAP(VARCHAR,VARCHAR)','out_args':'MAP(VARCHAR,VARCHAR)'," +
  "'ppid':'INTEGER','offset':'BIGINT'," +
  "'snaps':'STRUCT(total INTEGER, truncated INTEGER)'," +
  "'cfi':'STRUCT(walks INTEGER, stops MAP(VARCHAR,INTEGER))'}"

function sqlStr(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'"
}

// The ordered top->bottom chain of node ids for one event, in SQL - the same
// identity rules as graph-shape.chainOf: reversed java_stack, then reversed
// backtrace (bare-address frames dropped, `+0x<off>` stripped so call sites
// collapse), then the syscall. Interpolated into the slice CTE.
const CHAIN_SQL = `list_concat(
  list_transform(array_reverse(coalesce(java_stack, [])),
                 x -> 'java:' || regexp_replace(x, '\\+0x[0-9a-fA-F]+$', '')),
  list_transform(
    list_filter(array_reverse(list_transform(backtrace, b -> b.symbol)),
                s -> NOT (starts_with(s, '0x') AND NOT contains(s, '!'))),
    s -> 'nat:' || regexp_replace(s, '\\+0x[0-9a-fA-F]+$', '')
  ),
  ['sys:' || syscall]
)`

// The funcs analogue of CHAIN_SQL, over `call` rows. Reversed java_stack, then
// reversed backtrace; each cleaned "module!symbol" frame is promoted to fn: when
// it is in the run's hooked-set (the `h.fns` list cross-joined in), else nat:.
// Same cleaning as CHAIN_SQL: bare-address frames dropped, +0x offsets stripped.
const FUNCS_CHAIN_SQL = `list_concat(
  list_transform(array_reverse(coalesce(java_stack, [])),
                 x -> 'java:' || regexp_replace(x, '\\+0x[0-9a-fA-F]+$', '')),
  list_transform(
    list_transform(
      list_filter(array_reverse(list_transform(backtrace, b -> b.symbol)),
                  s -> NOT (starts_with(s, '0x') AND NOT contains(s, '!'))),
      s -> regexp_replace(s, '\\+0x[0-9a-fA-F]+$', '')),
    s -> CASE WHEN list_contains(h.fns, s) THEN 'fn:' || s ELSE 'nat:' || s END
  )
)`

// The ordered outermost->syscall chain for a syscall row `e` joined to its
// cfi_stack row `c` (aliases required by the callers). Mirrors chainOfCfi: reverse
// cfi_backtrace, map each frame by kind into the shared id grammar, drop the
// interpreter entry machinery + bare addresses, append the syscall leaf.
const CFI_CHAIN_SQL = `list_append(
  list_filter(
    list_transform(array_reverse(c.cfi_backtrace), b ->
      CASE
        WHEN b.kind = 'managed'
          THEN 'java:' || regexp_replace(regexp_replace(b.symbol, '^.*!', ''), '\\+0x[0-9a-fA-F]+$', '')
        WHEN b.kind = 'interp' AND b.addr = '0x0'
          THEN 'java:' || regexp_replace(b.symbol, '\\+0x[0-9a-fA-F]+$', '')
        WHEN b.kind = 'interp' THEN NULL
        WHEN starts_with(b.symbol, '0x') AND NOT contains(b.symbol, '!') THEN NULL
        ELSE 'nat:' || regexp_replace(b.symbol, '\\+0x[0-9a-fA-F]+$', '')
      END),
    x -> x IS NOT NULL),
  'sys:' || e.syscall)`

// The funcs analogue of CFI_CHAIN_SQL: a `call` row `e` joined to its cfi_stack
// row `c`, with the hooked-set `h.fns` cross-joined in so a native frame that is
// itself a hooked function collapses into its fn: node (unify). No syscall leaf.
const CFI_FUNCS_CHAIN_SQL = `list_filter(
  list_transform(array_reverse(c.cfi_backtrace), b ->
    CASE
      WHEN b.kind = 'managed'
        THEN 'java:' || regexp_replace(regexp_replace(b.symbol, '^.*!', ''), '\\+0x[0-9a-fA-F]+$', '')
      WHEN b.kind = 'interp' AND b.addr = '0x0'
        THEN 'java:' || regexp_replace(b.symbol, '\\+0x[0-9a-fA-F]+$', '')
      WHEN b.kind = 'interp' THEN NULL
      WHEN starts_with(b.symbol, '0x') AND NOT contains(b.symbol, '!') THEN NULL
      WHEN list_contains(h.fns, regexp_replace(b.symbol, '\\+0x[0-9a-fA-F]+$', ''))
        THEN 'fn:' || regexp_replace(b.symbol, '\\+0x[0-9a-fA-F]+$', '')
      ELSE 'nat:' || regexp_replace(b.symbol, '\\+0x[0-9a-fA-F]+$', '')
    END),
  x -> x IS NOT NULL)`

// Chain selection, shared by every site that builds a syscall/funcs chain: pick
// the cfi-recovered chain when the row's stack_id joined a cfi_stack sidecar
// row (aliased `c` by the caller's cfi CTE join), else fall back to the
// two-list chain. A single definition so the cfi-wiring cannot drift between
// call sites (see GraphStore.cfiCte).
const SYS_CHAIN_SEL = `CASE WHEN c.stack_id IS NOT NULL THEN ${CFI_CHAIN_SQL} ELSE ${CHAIN_SQL} END`
const FUNCS_CHAIN_SEL = `CASE WHEN c.stack_id IS NOT NULL THEN ${CFI_FUNCS_CHAIN_SQL} ELSE ${FUNCS_CHAIN_SQL} END`

// Rebuild a node's kind/label/module from its id via the shared labelForId.
// The SQL owns identity + counts; labelling stays in shared TS so it can
// never drift.
function nodeFromId(id: string, count: number): GraphNode {
  return { id, ...labelForId(id), count }
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  return Number(v as number | bigint)
}

// Detect a JSON-array trace vs newline-delimited JSONL by the first non-space byte.
function detectFormat(path: string): 'array' | 'newline_delimited' {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(64)
    const n = readSync(fd, buf, 0, 64, 0)
    return buf.subarray(0, n).toString('utf-8').trimStart().startsWith('[') ? 'array' : 'newline_delimited'
  } finally {
    closeSync(fd)
  }
}

const EMPTY_SCOPE: RuleScope = { rules: [], enabledOverrides: {} }

export interface RunInfo {
  runId: number
  file: string
  ingestedAt: string
  eventCount: number
  kinds: ('syscall' | 'funcs')[]
}

export class GraphStore {
  private instance?: DuckDBInstance
  private con?: DuckDBConnection
  private runsMap = new Map<number, RunInfo>()
  private nextRunId = 1
  private activeRunId?: number

  // runId -> ("<pid>|<basename>" -> load base). Built from `lib` records at
  // ingest; the basis for module-relative (ghidra) offsets. Kept in JS memory
  // (lib records are sparse) rather than in DuckDB, which cannot cleanly cast
  // the quoted-hex `start` strings.
  private modmap = new Map<number, Map<string, bigint>>()

  private static baseKey(pid: number, module: string): string {
    return `${pid}|${module}`
  }

  moduleBase(runId: number, pid: number, module: string): bigint | undefined {
    return this.modmap.get(runId)?.get(GraphStore.baseKey(pid, module))
  }

  private conn(): DuckDBConnection {
    if (!this.con) throw new Error('GraphStore: no run loaded (call ingest first)')
    return this.con
  }

  private async rows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    // filterToSql yields DB-agnostic primitives (strings/numbers), safe as DuckDB values.
    const r = await this.conn().run(sql, params as DuckDBValue[])
    return (await r.getRowObjects()) as Record<string, unknown>[]
  }

  private async scalar(sql: string, params: unknown[] = []): Promise<number> {
    const rows = await this.rows(sql, params)
    return Number((rows[0] as { n: number | bigint }).n)
  }

  // Load a JSONL run into DuckDB. Raw records stay in the database, off the JS
  // heap. Returns the run id, syscall count, and the malformed-line count.
  async ingest(
    path: string,
    onProgress?: (pct: number) => void,
  ): Promise<{ runId: number; eventCount: number; errors: number; kinds: ('syscall' | 'funcs')[] }> {
    if (!this.instance) {
      this.instance = await DuckDBInstance.create(':memory:')
      this.con = await this.instance.connect()
    }
    const runId = this.nextRunId++
    const fmt = detectFormat(path)
    const firstRun = this.runsMap.size === 0

    const source =
      `SELECT ${runId} AS run_id, * FROM read_json(${sqlStr(path)}, ` +
      `format='${fmt}', columns=${COLS}, maximum_object_size=20000000, ignore_errors=true)`

    if (firstRun) await this.conn().run(`CREATE TABLE ev AS ${source}`)
    else await this.conn().run(`INSERT INTO ev ${source}`)

    // Companion CFI stack sidecar: <run>.stacks holds the full ordered walk
    // (cfi_stack records) that recovers JNI interleaving the FP backtrace drops.
    // Absent is normal (non-snapshot run) - fall back to the two-list chain.
    const stacksPath = path + '.stacks'
    if (existsSync(stacksPath)) {
      await this.conn().run(
        `INSERT INTO ev SELECT ${runId} AS run_id, * FROM read_json(${sqlStr(stacksPath)}, ` +
        `format='${fmt}', columns=${COLS}, maximum_object_size=20000000, ignore_errors=true)`,
      )
    }

    // A malformed line becomes an all-null row (type NULL); a valid non-syscall
    // record keeps its type (e.g. 'lib'). Count them apart, keep only syscalls.
    const errors = await this.scalar(
      `SELECT count(*) n FROM ev WHERE run_id = ${runId} AND type IS NULL`,
    )
    const eventCount = await this.scalar(
      `SELECT count(*) n FROM ev WHERE run_id = ${runId} AND type IN ('syscall', 'call')`,
    )
    const hasSyscall = (await this.scalar(
      `SELECT count(*) n FROM ev WHERE run_id = ${runId} AND type = 'syscall'`)) > 0
    const hasFuncs = (await this.scalar(
      `SELECT count(*) n FROM ev WHERE run_id = ${runId} AND type = 'call'`)) > 0
    const kinds: ('syscall' | 'funcs')[] = []
    if (hasSyscall) kinds.push('syscall')
    if (hasFuncs) kinds.push('funcs')

    // Build the per-run module map from `lib` records before they are deleted.
    // Load base = the lowest segment start for a (pid, library basename).
    const libRows = await this.rows(
      `SELECT pid, library, start FROM ev
       WHERE run_id = ${runId} AND type = 'lib' AND library IS NOT NULL AND start IS NOT NULL`,
    )
    const rmap = new Map<string, bigint>()
    for (const r of libRows) {
      const start = parseHexAddr(String(r.start))
      if (start === null) continue
      const basename = String(r.library).split('/').pop() as string
      const key = GraphStore.baseKey(num(r.pid)!, basename)
      const prev = rmap.get(key)
      if (prev === undefined || start < prev) rmap.set(key, start)
    }
    this.modmap.set(runId, rmap)

    // EPIC A: only drop malformed lines now - every other engine's records
    // (func/call/return/coverage/...) are retained, partitioned by `type` for
    // downstream adapters. Queries below scope to `type = 'syscall'` explicitly
    // instead of relying on `ev` being syscall-only.
    await this.conn().run(
      `DELETE FROM ev WHERE run_id = ${runId} AND type IS NULL`,
    )

    this.runsMap.set(runId, {
      runId,
      file: path,
      ingestedAt: new Date().toISOString(),
      eventCount,
      kinds,
    })
    this.activeRunId = runId
    onProgress?.(100)
    return { runId, eventCount, errors, kinds }
  }

  runs(): RunInfo[] {
    return [...this.runsMap.values()]
  }

  private resolveRun(runId?: number): number {
    const id = runId ?? this.activeRunId
    if (id === undefined) throw new Error('GraphStore: no run loaded (call ingest first)')
    return id
  }

  // Deduped cfi_stack CTE for run `rid`: one row per stack_id (any_value picks
  // an arbitrary one when ARES's dedup LRU re-emits a duplicate for the same
  // stack_id). Every chain-building query LEFT JOINs this by stack_id and
  // selects with SYS_CHAIN_SEL / FUNCS_CHAIN_SEL - the single source of truth
  // so the cfi wiring cannot drift between call sites.
  private cfiCte(rid: number): string {
    return `cfi AS (SELECT stack_id, any_value(cfi_backtrace) AS cfi_backtrace FROM ev WHERE run_id = ${rid} AND type = 'cfi_stack' GROUP BY stack_id)`
  }

  // The engine a run's list/count should present: 'funcs' when it has call rows
  // and no syscalls, else 'syscall'. (A mixed `trace` run lists syscalls in
  // Phase 1; a unified trace list is backlog.)
  private engineOf(runId: number): 'syscall' | 'funcs' {
    const info = this.runsMap.get(runId)
    if (info && info.kinds.includes('funcs') && !info.kinds.includes('syscall')) return 'funcs'
    return 'syscall'
  }

  // Master-table page, filtered in SQL.
  async table(
    filter: Filter,
    page: { limit: number; offset: number },
    runId?: number,
  ): Promise<TableRow[]> {
    const rid = this.resolveRun(runId)
    const limit = Math.max(0, Math.trunc(page.limit))
    const offset = Math.max(0, Math.trunc(page.offset))
    const { where, params } = filterToSql(filter)
    if (this.engineOf(rid) === 'funcs') {
      // Calls are filtered in a CTE (single ev scope, so the shared filter's
      // unqualified columns stay unambiguous), then each call LEFT JOINs the
      // return sharing its tracer id for retval/elapsed. The per-call span id is
      // unique per invocation, so the join is 1:1 (recursion/reentrancy included);
      // a call with no return folds to null.
      const rows = await this.rows(
        `WITH calls AS (SELECT * FROM ev WHERE run_id = ${rid} AND type = 'call' AND span IS NULL AND (${where}))
         SELECT c.id AS id, c.tid AS tid,
           c.module || '!' || c.symbol AS fn,
           regexp_replace(c.backtrace[2].symbol, '\\+0x[0-9a-fA-F]+$', '') AS caller,
           r.retval AS retval, r.elapsed_ns AS elapsed,
           coalesce(nullif(array_to_string(map_values(c.string_args), ' '), ''),
                    nullif(array_to_string(c.args, ' '), '')) AS arg
         FROM calls c LEFT JOIN ev r ON r.run_id = ${rid} AND r.type = 'return' AND r.span IS NULL AND r.id = c.id
         ORDER BY c.id LIMIT ${limit} OFFSET ${offset}`, params)
      return rows.map(r => ({
        id: num(r.id)!, tid: num(r.tid)!, engine: 'func' as const,
        syscall: '', retval: num(r.retval), hasJava: false, topJava: null, topNative: null,
        arg: (r.arg as string | null) ?? '',
        fn: r.fn as string, caller: (r.caller as string | null) ?? null, elapsed: num(r.elapsed),
      }))
    }
    const rows = await this.rows(
      `SELECT id, tid, syscall, retval,
         (java_stack IS NOT NULL AND len(java_stack) > 0) AS hasJava,
         java_stack[1] AS topJava,
         backtrace[1].symbol AS topNative,
         coalesce(
           nullif(array_to_string(map_values(string_args), ' '), ''),
           nullif(array_to_string(map_values(fd_args), ' '), ''),
           nullif(array_to_string(map_values(decoded_args), ' '), ''),
           nullif(array_to_string(args, ' '), '')
         ) AS arg
       FROM ev WHERE run_id = ${rid} AND type = 'syscall' AND span IS NULL AND (${where})
       ORDER BY id
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    )
    return rows.map(r => ({
      id: num(r.id)!,
      tid: num(r.tid)!,
      engine: 'syscall' as const,
      syscall: r.syscall as string,
      retval: num(r.retval),
      hasJava: Boolean(r.hasJava),
      topJava: (r.topJava as string | null) ?? null,
      topNative: (r.topNative as string | null) ?? null,
      arg: (r.arg as string | null) ?? '',
    }))
  }

  // Total events matching the filter. The table page is a capped window over
  // this, so the renderer shows "first N of <count>" when the two diverge.
  async count(filter: Filter = {}, runId?: number): Promise<number> {
    const rid = this.resolveRun(runId)
    const { where, params } = filterToSql(filter)
    if (this.engineOf(rid) === 'funcs') {
      return this.scalar(
        `SELECT count(*) n FROM ev WHERE run_id = ${rid} AND type = 'call' AND span IS NULL AND (${where})`, params)
    }
    return this.scalar(
      `SELECT count(*) n FROM ev WHERE run_id = ${rid} AND type = 'syscall' AND span IS NULL AND (${where})`,
      params,
    )
  }

  // Aggregated syscall->native->java graph over the filtered events, capped.
  // Reconstructs identity + counts in SQL, then assembles GraphNodes with the
  // shared labelling - matched node-for-node against the foldEvents oracle.
  // Unions in the funcs engine's own SQL chain (FUNCS_CHAIN_SQL) over `call`
  // rows, matched against the foldFuncEvents oracle - a funcs run renders
  // without a separate JS adapter. Shared `nat:` nodes across the two engines
  // are intentional (mergeGraphs sums their counts into one node).
  // GraphSlice.eventCount here counts syscall OR funcs rows (was syscall-only
  // before the funcs union), so a funcs-only run reports a non-zero count.
  async slice(filter: Filter = {}, cap?: number, runId?: number): Promise<GraphSlice> {
    const rid = this.resolveRun(runId)
    const { where, params } = filterToSql(filter)

    // syscall chains: LEFT JOIN each syscall row to its cfi_stack sidecar (by
    // stack_id) and pick CFI_CHAIN_SQL when one exists, else CHAIN_SQL.
    const sysScoped = `run_id = ${rid} AND type = 'syscall' AND span IS NULL AND (${where})`
    const sysCte =
      `WITH ${this.cfiCte(rid)},
            chains AS (
              SELECT e.id AS eid,
                ${SYS_CHAIN_SEL} AS chain
              FROM ev e LEFT JOIN cfi c ON e.stack_id = c.stack_id
              WHERE ${sysScoped})`
    const sysNodeRows = await this.rows(
      `${sysCte} SELECT nid, count(*) AS c FROM (SELECT unnest(chain) AS nid FROM chains) GROUP BY nid`, params)
    const sysEdgeRows = await this.rows(
      `${sysCte} SELECT chain[i] AS src, chain[i + 1] AS tgt, count(*) AS c
       FROM chains, range(1, len(chain)) AS t(i) GROUP BY src, tgt`, params)

    // funcs chains: hooked-set cross-joined as h.fns; same aggregation shape.
    // `span IS NULL` keeps this to funcs' own records - a span-tagged correlate
    // `call` row must not leak into the funcs graph, the hooked-set, or eventCount.
    const fnScoped = `run_id = ${rid} AND type = 'call' AND span IS NULL AND (${where})`
    const fnCte =
      `WITH h AS (SELECT list(DISTINCT module || '!' || symbol) AS fns FROM ev WHERE run_id = ${rid} AND type = 'call' AND span IS NULL),
            ${this.cfiCte(rid)},
            chains AS (
              SELECT ${FUNCS_CHAIN_SEL} AS chain
              FROM ev e LEFT JOIN cfi c ON e.stack_id = c.stack_id, h
              WHERE ${fnScoped})`
    const fnNodeRows = await this.rows(
      `${fnCte} SELECT nid, count(*) AS c FROM (SELECT unnest(chain) AS nid FROM chains) GROUP BY nid`, params)
    const fnEdgeRows = await this.rows(
      `${fnCte} SELECT chain[i] AS src, chain[i + 1] AS tgt, count(*) AS c
       FROM chains, range(1, len(chain)) AS t(i) GROUP BY src, tgt`, params)

    const eventCount = await this.scalar(
      `SELECT count(*) AS n FROM ev WHERE (${sysScoped}) OR (${fnScoped})`, [...params, ...params])

    const toNodes = (rows: Record<string, unknown>[]) => rows.map(r => nodeFromId(r.nid as string, Number(r.c)))
    const toEdges = (rows: Record<string, unknown>[]) => rows.map(r => {
      const source = r.src as string, target = r.tgt as string
      return { id: `${source}=>${target}`, source, target, count: Number(r.c) }
    })

    const { nodes, edges } = mergeGraphs(
      { nodes: toNodes(sysNodeRows), edges: toEdges(sysEdgeRows) },
      { nodes: toNodes(fnNodeRows), edges: toEdges(fnEdgeRows) },
    )
    return capSlice(nodes, edges, eventCount, cap)
  }

  // Aggregated stack rollup over the filtered events: distinct full chains with
  // occurrence counts, for the flame view. Reuses CHAIN_SQL (same identity as the
  // graph). Heaviest first; capped by maxChains to bound the IPC payload.
  async stackRollup(filter: Filter = {}, maxChains = 5000, runId?: number): Promise<StackRollup> {
    const rid = this.resolveRun(runId)
    const { where, params } = filterToSql(filter)
    const scoped = `run_id = ${rid} AND type = 'syscall' AND span IS NULL AND (${where})`
    const cte =
      `WITH ${this.cfiCte(rid)},
            chains AS (
              SELECT ${SYS_CHAIN_SEL} AS chain
              FROM ev e LEFT JOIN cfi c ON e.stack_id = c.stack_id
              WHERE ${scoped})`

    const distinctChains = await this.scalar(
      `${cte} SELECT count(*) AS n FROM (SELECT chain FROM chains GROUP BY chain)`,
      params,
    )
    const eventCount = await this.scalar(`SELECT count(*) AS n FROM ev WHERE ${scoped}`, params)
    const lim = Math.max(0, Math.trunc(maxChains))
    const rows = await this.rows(
      `${cte} SELECT chain, count(*) AS c FROM chains GROUP BY chain ORDER BY c DESC LIMIT ${lim}`,
      params,
    )
    return {
      rows: rows.map(r => ({ chain: (r.chain as { items: string[] }).items, count: Number(r.c) })),
      eventCount,
      distinctChains,
      truncated: distinctChains > lim,
    }
  }

  // One raw record, reconstructed as a plain SyscallEvent via DuckDB's to_json.
  // `id` is an internal integer, safe to inline. On a funcs run, the call row
  // (id) is LEFT JOINed with its paired return (shared id) so the detail panel
  // gets retval/elapsed_ns/out_args merged onto the call, same as `table`.
  async eventById(id: number, runId?: number): Promise<SyscallEvent | FuncEvent | undefined> {
    const rid = this.resolveRun(runId)
    if (this.engineOf(rid) === 'funcs') {
      const rows = await this.rows(
        `SELECT to_json(c) AS js, r.retval AS retval, r.elapsed_ns AS elapsed, to_json(r.out_args) AS out_args
         FROM ev c LEFT JOIN ev r ON r.run_id = ${rid} AND r.type = 'return' AND r.span IS NULL AND r.id = c.id
         WHERE c.run_id = ${rid} AND c.type = 'call' AND c.span IS NULL AND c.id = ${Math.trunc(id)}`,
      )
      if (rows.length === 0) return undefined
      const { run_id: _drop, ...call } = JSON.parse(rows[0].js as string)
      return { ...call, retval: num(rows[0].retval) ?? undefined, elapsed_ns: num(rows[0].elapsed) ?? undefined,
               out_args: JSON.parse((rows[0].out_args as string | null) ?? 'null') ?? undefined } as FuncEvent
    }
    const rows = await this.rows(
      `SELECT to_json(ev) AS js FROM ev WHERE run_id = ${rid} AND type = 'syscall' AND span IS NULL AND id = ${Math.trunc(id)}`,
    )
    if (rows.length === 0) return undefined
    // to_json includes run_id; drop it so the shape stays a clean SyscallEvent.
    const { run_id: _drop, ...ev } = JSON.parse(rows[0].js as string)
    return ev as SyscallEvent
  }

  // The run's end-of-run `coverage` summary (EPIC A A7), if the capture had
  // one. Not graph data - a per-run health banner. `LIMIT 1`: a run has at
  // most one coverage record (one engine, one end-of-run summary).
  async coverage(runId?: number): Promise<CoverageEvent | undefined> {
    const rid = this.resolveRun(runId)
    const rows = await this.rows(
      `SELECT to_json(ev) AS js FROM ev WHERE run_id = ${rid} AND type = 'coverage' LIMIT 1`,
    )
    if (rows.length === 0) return undefined
    const { run_id: _drop, ...ev } = JSON.parse(rows[0].js as string)
    return ev as CoverageEvent
  }

  // The raw records whose reconstructed chain touches `nodeId`, honouring the
  // active filter. Feeds the node inspector on demand (records stay in DuckDB).
  async nodeEvents(
    nodeId: string,
    filter: Filter = {},
    limit = 500,
    runId?: number,
  ): Promise<(SyscallEvent | FuncEvent)[]> {
    const rid = this.resolveRun(runId)
    const { where, params } = filterToSql(filter)
    const lim = Math.max(0, Math.trunc(limit))
    if (this.engineOf(rid) === 'funcs') {
      const fnScoped = `run_id = ${rid} AND type = 'call' AND span IS NULL AND (${where})`
      const cte =
        `WITH h AS (SELECT list(DISTINCT module || '!' || symbol) AS fns FROM ev WHERE run_id = ${rid} AND type = 'call' AND span IS NULL),
              ${this.cfiCte(rid)},
              chains AS (SELECT e.id AS eid, ${FUNCS_CHAIN_SEL} AS chain FROM ev e LEFT JOIN cfi c ON e.stack_id = c.stack_id, h WHERE ${fnScoped})`
      const rows = await this.rows(
        `${cte}
         SELECT to_json(c) AS js, r.retval AS retval, r.elapsed_ns AS elapsed, to_json(r.out_args) AS out_args
         FROM ev c JOIN chains ON c.id = chains.eid AND c.run_id = ${rid} AND c.type = 'call' AND c.span IS NULL
         LEFT JOIN ev r ON r.run_id = ${rid} AND r.type = 'return' AND r.span IS NULL AND r.id = c.id
         WHERE list_contains(chain, ?) ORDER BY c.id LIMIT ${lim}`,
        [...params, nodeId],
      )
      return rows.map(row => {
        const { run_id: _drop, ...call } = JSON.parse(row.js as string)
        return { ...call, retval: num(row.retval) ?? undefined, elapsed_ns: num(row.elapsed) ?? undefined,
                 out_args: JSON.parse((row.out_args as string | null) ?? 'null') ?? undefined } as FuncEvent
      })
    }
    const scoped = `run_id = ${rid} AND type = 'syscall' AND span IS NULL AND (${where})`
    const cte = `WITH ${this.cfiCte(rid)}, chains AS (SELECT e.id AS eid, ${SYS_CHAIN_SEL} AS chain FROM ev e LEFT JOIN cfi c ON e.stack_id = c.stack_id WHERE ${scoped})`
    const rows = await this.rows(
      `${cte} SELECT to_json(ev) AS js FROM ev JOIN chains ON ev.id = chains.eid AND ev.run_id = ${rid}
       WHERE list_contains(chain, ?) ORDER BY ev.id LIMIT ${lim}`,
      [...params, nodeId],
    )
    return rows.map(r => {
      const { run_id: _drop, ...ev } = JSON.parse(r.js as string)
      return ev as SyscallEvent
    })
  }

  // Module-relative call-site offsets for a native function node: the ghidra
  // image-base offsets (addr - load_base) among that function's backtrace
  // frames, aggregated across the filtered events whose chain touches the node.
  // The data behind the offset popup (Copy / Copy-as-JSON). Frames whose module
  // has no load base (never mapped by a `lib` record) are skipped.
  async nodeOffsets(nodeId: string, filter: Filter = {}, runId?: number): Promise<OffsetRow[]> {
    const rid = this.resolveRun(runId)
    const meta = labelForId(nodeId)
    if (meta.kind !== 'native' || meta.module === null) return []
    // The node's pinned symbol, if any: 'nat:module!symbol' -> symbol, else null.
    const rest = nodeId.slice(4)
    const bang = rest.indexOf('!')
    const wantSymbol = bang >= 0 ? rest.slice(bang + 1) : null

    // Capped at 5000 events: for a very hot node this silently under-aggregates
    // `count` past the cap (tracked in BACKLOG).
    const events = await this.nodeEvents(nodeId, filter, 5000, rid)

    // vaddr(hex) -> accumulating row.
    const acc = new Map<string, OffsetRow>()
    for (const ev of events) {
      // nodeOffsets is a syscall-only view (rows key on `syscall`); a funcs run's
      // nat: nodes are skipped here, matching the pre-widen behaviour where a
      // funcs run's nodeEvents (scoped to type='syscall') returned none anyway.
      if (ev.type !== 'syscall') continue
      const base = this.moduleBase(rid, ev.pid, meta.module)
      // Distinct offsets this event contributes (one event counts an offset once).
      const seen = new Set<string>()
      for (const f of ev.backtrace) {
        const p = parseFrameSymbol(f.symbol)
        if (p.module !== meta.module) continue
        if (wantSymbol === null ? p.symbol !== null : p.symbol !== wantSymbol) continue
        let offset: string
        if (base === undefined) {
          offset = '[unmapped]'
        } else {
          const addr = parseHexAddr(f.addr)
          if (addr === null) continue
          offset = moduleRelative(addr, base)
        }
        if (seen.has(offset)) continue
        seen.add(offset)
        const key = offset + ' ' + ev.syscall
        let row = acc.get(key)
        if (!row) {
          row = { module: meta.module, offset, symbol: p.symbol, syscall: ev.syscall,
                  argsSample: ev.decoded_args ?? {}, count: 0, sampleEventId: ev.id }
          acc.set(key, row)
        }
        row.count++
      }
    }
    return [...acc.values()]
  }

  // Score the run against a resolved rule set. Main resolves built-in + global +
  // project rules and passes them in; when omitted we default to the enabled
  // built-ins so single-arg callers (tests) keep working. compileWhere bounds the
  // scan to real candidates (off-heap); scoreWith re-checks each and is the
  // scoring authority.
  async suggest(runId?: number, rules?: Rule[]): Promise<Suggestion[]> {
    const rid = this.resolveRun(runId)
    const effective = (rules ?? resolveRules(BUILTIN_RULES, EMPTY_SCOPE, EMPTY_SCOPE)).filter(r => r.enabled)
    if (effective.length === 0) return []
    const where = compileWhere(effective)
    let rows
    try {
      rows = await this.rows(
        `SELECT to_json(ev) AS js FROM ev WHERE run_id = ${rid} AND type = 'syscall' AND span IS NULL AND (${where})`,
      )
    } catch (e) {
      // Defense in depth: a compiled rule DuckDB rejects (e.g. an RE2-incompatible
      // regex that bypassed validation) must not break the whole suggestions panel.
      console.error(`suggest: rule query failed, returning no suggestions: ${(e as Error).message}`)
      return []
    }
    const all: Suggestion[] = []
    for (const r of rows) {
      const { run_id: _drop, ...ev } = JSON.parse(r.js as string)
      all.push(...scoreWith(effective, ev as SyscallEvent))
    }
    return aggregate(all)
  }

  // Preview a single (draft) rule against a run without persisting it. Bounded by
  // compileWhere like suggest; returns how many events fire and how many distinct
  // native targets result. Query failure yields zeros (mirrors suggest's guard).
  async previewRule(runId: number | undefined, rule: Rule): Promise<{ events: number; targets: number }> {
    const rid = this.resolveRun(runId)
    const where = compileWhere([rule])
    let rows
    try {
      rows = await this.rows(`SELECT to_json(ev) AS js FROM ev WHERE run_id = ${rid} AND type = 'syscall' AND span IS NULL AND (${where})`)
    } catch (e) {
      console.error(`previewRule: rule query failed: ${(e as Error).message}`)
      return { events: 0, targets: 0 }
    }
    const all: Suggestion[] = []
    let events = 0
    for (const r of rows) {
      const { run_id: _drop, ...ev } = JSON.parse(r.js as string)
      const hits = scoreWith([rule], ev as SyscallEvent)
      if (hits.length > 0) events++
      all.push(...hits)
    }
    return { events, targets: aggregate(all).length }
  }

  // Test-only escape hatch: run a raw read query. Used by the lockstep test to
  // check DuckDB WHERE-admission directly.
  async raw(sql: string): Promise<Record<string, DuckDBValue>[]> {
    return this.rows(sql) as Promise<Record<string, DuckDBValue>[]>
  }

  private async nodeCounts(runId: number, filter: Filter = {}): Promise<Map<string, number>> {
    const { where, params } = filterToSql(filter)
    const scoped = `run_id = ${runId} AND type = 'syscall' AND span IS NULL AND (${where})`
    const rows = await this.rows(
      `WITH ${this.cfiCte(runId)}, chains AS (SELECT ${SYS_CHAIN_SEL} AS chain FROM ev e LEFT JOIN cfi c ON e.stack_id = c.stack_id WHERE ${scoped})
       SELECT nid, count(*) AS c FROM (SELECT unnest(chain) AS nid FROM chains) GROUP BY nid`,
      params,
    )
    return new Map(rows.map(r => [r.nid as string, Number(r.c)]))
  }

  async diffTable(runA: number, runB: number, filter: Filter = {}, cap?: number): Promise<DiffRow[]> {
    const [ca, cb] = await Promise.all([this.nodeCounts(runA, filter), this.nodeCounts(runB, filter)])
    const ids = new Set([...ca.keys(), ...cb.keys()])
    const rows: DiffRow[] = []
    for (const id of ids) {
      const countA = ca.get(id) ?? 0
      const countB = cb.get(id) ?? 0
      const n = nodeFromId(id, 0)
      rows.push({ id, kind: n.kind, label: n.label, countA, countB,
        delta: countB - countA, presence: presenceOf(countA, countB) })
    }
    // Divergence first (A-only / B-only before shared), then by magnitude.
    const divergent = (p: DiffRow['presence']) => (p === 'both' ? 1 : 0)
    rows.sort((x, y) => divergent(x.presence) - divergent(y.presence) || Math.abs(y.delta) - Math.abs(x.delta))
    const limit = cap ?? rows.length
    return rows.slice(0, limit)
  }

  async diffSlice(runA: number, runB: number, nodeId: string, filter: Filter = {}): Promise<MergedSlice> {
    const [sa, sb] = await Promise.all([
      this.slice(filter, undefined, runA),
      this.slice(filter, undefined, runB),
    ])
    const idsA = new Set(sa.nodes.map(n => n.id))
    const idsB = new Set(sb.nodes.map(n => n.id))
    const merged = new Map<string, MergedNode>()
    for (const n of [...sa.nodes, ...sb.nodes]) {
      if (merged.has(n.id)) continue
      const presence = presenceOf(idsA.has(n.id) ? 1 : 0, idsB.has(n.id) ? 1 : 0)
      merged.set(n.id, { ...n, presence })
    }
    const edgeKey = (e: { source: string; target: string }) => `${e.source}=>${e.target}`
    const edgesA = new Set(sa.edges.map(edgeKey))
    const edgesB = new Set(sb.edges.map(edgeKey))
    const mergedEdges = new Map<string, GraphEdge & { presence: MergedNode['presence'] }>()
    for (const e of [...sa.edges, ...sb.edges]) {
      const k = edgeKey(e)
      if (mergedEdges.has(k)) continue
      mergedEdges.set(k, { ...e, presence: presenceOf(edgesA.has(k) ? 1 : 0, edgesB.has(k) ? 1 : 0) })
    }
    // Keep only the neighbourhood of nodeId (nodes on an edge touching it, plus itself).
    const keep = new Set<string>([nodeId])
    for (const e of mergedEdges.values()) {
      if (e.source === nodeId) keep.add(e.target)
      if (e.target === nodeId) keep.add(e.source)
    }
    const nodes = [...merged.values()].filter(n => keep.has(n.id))
    const edges = [...mergedEdges.values()].filter(e => keep.has(e.source) && keep.has(e.target))
    return { nodes, edges, truncated: sa.truncated || sb.truncated }
  }

  // Which of `targets` are absent from the run: node ids gone after a re-ingest
  // (symbol resolution shifted, binary rebuilt) or missing edges. The run's
  // node-id set + distinct edge-key set are built and checked here in main, so
  // only the small target list crosses IPC. `edge:` targets check edges; all
  // others check node ids.
  async orphanTargets(targets: string[], runId?: number): Promise<string[]> {
    const rid = this.resolveRun(runId)
    const nodeIds = new Set((await this.nodeCounts(rid)).keys())
    const edgeRows = await this.rows(
      `WITH ${this.cfiCte(rid)},
            chains AS (SELECT ${SYS_CHAIN_SEL} AS chain FROM ev e LEFT JOIN cfi c ON e.stack_id = c.stack_id
        WHERE run_id = ${rid} AND type = 'syscall' AND span IS NULL)
       SELECT DISTINCT chain[i] AS src, chain[i + 1] AS tgt
       FROM chains, range(1, len(chain)) AS t(i)`,
    )
    const edgeKeys = new Set(edgeRows.map(r => `edge:${r.src as string}=>${r.tgt as string}`))
    return targets.filter(t => (t.startsWith('edge:') ? !edgeKeys.has(t) : !nodeIds.has(t)))
  }

  async close(): Promise<void> {
    this.con?.closeSync()
    this.instance?.closeSync()
    this.con = undefined
    this.instance = undefined
    this.runsMap.clear()
    this.modmap.clear()
    this.activeRunId = undefined
    this.nextRunId = 1
  }
}

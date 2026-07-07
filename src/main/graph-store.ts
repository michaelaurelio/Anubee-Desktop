import { openSync, readSync, closeSync } from 'node:fs'
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api'
import type { SyscallEvent } from '@shared/events'
import { filterToSql, type Filter } from '@shared/filter'
import { capSlice, labelForId, type GraphNode, type GraphEdge, type GraphSlice } from '@shared/graph-shape'
import type { TableRow } from '@shared/table'
import type { StackRollup } from '@shared/flame-shape'
import { compileWhere, scoreWith, aggregate, resolveRules, BUILTIN_RULES, type Rule, type RuleScope, type Suggestion } from '@shared/rasp-heuristics'
import { presenceOf, type DiffRow, type MergedSlice, type MergedNode } from '@shared/diff'

export type { TableRow }

// Explicit read_json schema so DuckDB never mis-infers the nested/heterogeneous
// fields. Extends the ARES host store's schema (tools/ares-mcp/trace_store.py)
// with `type`, `stack_id`, and `java_stack` - the last is the RASP bridge this
// app is built around. `type` also lets ingest separate a malformed line
// (all-null row → type NULL) from a valid non-syscall record (type='lib').
const COLS =
  "{'type':'VARCHAR','id':'BIGINT','pid':'INTEGER','tid':'INTEGER'," +
  "'syscall_nr':'BIGINT','syscall':'VARCHAR','args':'VARCHAR[]','retval':'BIGINT'," +
  "'string_args':'MAP(VARCHAR,VARCHAR)','fd_args':'MAP(VARCHAR,VARCHAR)'," +
  "'decoded_args':'MAP(VARCHAR,VARCHAR)','sock_addr':'VARCHAR','stack_id':'BIGINT'," +
  "'java_stack':'VARCHAR[]'," +
  "'backtrace':'STRUCT(frame INTEGER, addr VARCHAR, symbol VARCHAR)[]'}"

function sqlStr(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'"
}

// The ordered top->bottom chain of node ids for one event, in SQL - the same
// identity rules as graph-shape.chainOf: reversed java_stack, then reversed
// backtrace (bare-address frames dropped, `+0x<off>` stripped so call sites
// collapse), then the syscall. Interpolated into the slice CTE.
const CHAIN_SQL = `list_concat(
  list_transform(array_reverse(coalesce(java_stack, [])), x -> 'java:' || x),
  list_transform(
    list_filter(array_reverse(list_transform(backtrace, b -> b.symbol)),
                s -> NOT (starts_with(s, '0x') AND NOT contains(s, '!'))),
    s -> 'nat:' || regexp_replace(s, '\\+0x[0-9a-fA-F]+$', '')
  ),
  ['sys:' || syscall]
)`

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
}

export class GraphStore {
  private instance?: DuckDBInstance
  private con?: DuckDBConnection
  private runsMap = new Map<number, RunInfo>()
  private nextRunId = 1
  private activeRunId?: number

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
  ): Promise<{ runId: number; eventCount: number; errors: number }> {
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

    // A malformed line becomes an all-null row (type NULL); a valid non-syscall
    // record keeps its type (e.g. 'lib'). Count them apart, keep only syscalls.
    const errors = await this.scalar(
      `SELECT count(*) n FROM ev WHERE run_id = ${runId} AND type IS NULL`,
    )
    const eventCount = await this.scalar(
      `SELECT count(*) n FROM ev WHERE run_id = ${runId} AND type = 'syscall'`,
    )
    await this.conn().run(
      `DELETE FROM ev WHERE run_id = ${runId} AND type IS DISTINCT FROM 'syscall'`,
    )

    this.runsMap.set(runId, {
      runId,
      file: path,
      ingestedAt: new Date().toISOString(),
      eventCount,
    })
    this.activeRunId = runId
    onProgress?.(100)
    return { runId, eventCount, errors }
  }

  runs(): RunInfo[] {
    return [...this.runsMap.values()]
  }

  private resolveRun(runId?: number): number {
    const id = runId ?? this.activeRunId
    if (id === undefined) throw new Error('GraphStore: no run loaded (call ingest first)')
    return id
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
    const rows = await this.rows(
      `SELECT id, tid, syscall, retval,
         (java_stack IS NOT NULL AND len(java_stack) > 0) AS hasJava,
         java_stack[1] AS topJava,
         backtrace[1].symbol AS topNative
       FROM ev WHERE run_id = ${rid} AND (${where})
       ORDER BY id
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    )
    return rows.map(r => ({
      id: num(r.id)!,
      tid: num(r.tid)!,
      syscall: r.syscall as string,
      retval: num(r.retval),
      hasJava: Boolean(r.hasJava),
      topJava: (r.topJava as string | null) ?? null,
      topNative: (r.topNative as string | null) ?? null,
    }))
  }

  // Aggregated syscall->native->java graph over the filtered events, capped.
  // Reconstructs identity + counts in SQL, then assembles GraphNodes with the
  // shared labelling - matched node-for-node against the foldEvents oracle.
  async slice(filter: Filter = {}, cap?: number, runId?: number): Promise<GraphSlice> {
    const rid = this.resolveRun(runId)
    const { where, params } = filterToSql(filter)
    const scoped = `run_id = ${rid} AND (${where})`
    const cte = `WITH chains AS (SELECT id AS eid, ${CHAIN_SQL} AS chain FROM ev WHERE ${scoped})`

    const nodeRows = await this.rows(
      `${cte} SELECT nid, count(*) AS c FROM (SELECT unnest(chain) AS nid FROM chains) GROUP BY nid`,
      params,
    )
    const edgeRows = await this.rows(
      `${cte} SELECT chain[i] AS src, chain[i + 1] AS tgt, count(*) AS c
       FROM chains, range(1, len(chain)) AS t(i) GROUP BY src, tgt`,
      params,
    )
    const eventCount = await this.scalar(`SELECT count(*) AS n FROM ev WHERE ${scoped}`, params)

    const nodes: GraphNode[] = nodeRows.map(r => nodeFromId(r.nid as string, Number(r.c)))
    const edges: GraphEdge[] = edgeRows.map(r => {
      const source = r.src as string
      const target = r.tgt as string
      return { id: `${source}=>${target}`, source, target, count: Number(r.c) }
    })
    return capSlice(nodes, edges, eventCount, cap)
  }

  // Aggregated stack rollup over the filtered events: distinct full chains with
  // occurrence counts, for the flame view. Reuses CHAIN_SQL (same identity as the
  // graph). Heaviest first; capped by maxChains to bound the IPC payload.
  async stackRollup(filter: Filter = {}, maxChains = 5000, runId?: number): Promise<StackRollup> {
    const rid = this.resolveRun(runId)
    const { where, params } = filterToSql(filter)
    const scoped = `run_id = ${rid} AND (${where})`
    const cte = `WITH chains AS (SELECT ${CHAIN_SQL} AS chain FROM ev WHERE ${scoped})`

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
  // `id` is an internal integer, safe to inline.
  async eventById(id: number, runId?: number): Promise<SyscallEvent | undefined> {
    const rid = this.resolveRun(runId)
    const rows = await this.rows(
      `SELECT to_json(ev) AS js FROM ev WHERE run_id = ${rid} AND id = ${Math.trunc(id)}`,
    )
    if (rows.length === 0) return undefined
    // to_json includes run_id; drop it so the shape stays a clean SyscallEvent.
    const { run_id: _drop, ...ev } = JSON.parse(rows[0].js as string)
    return ev as SyscallEvent
  }

  // The raw records whose reconstructed chain touches `nodeId`, honouring the
  // active filter. Feeds the node inspector on demand (records stay in DuckDB).
  async nodeEvents(
    nodeId: string,
    filter: Filter = {},
    limit = 500,
    runId?: number,
  ): Promise<SyscallEvent[]> {
    const rid = this.resolveRun(runId)
    const { where, params } = filterToSql(filter)
    const lim = Math.max(0, Math.trunc(limit))
    const scoped = `run_id = ${rid} AND (${where})`
    const cte = `WITH chains AS (SELECT id AS eid, ${CHAIN_SQL} AS chain FROM ev WHERE ${scoped})`
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
        `SELECT to_json(ev) AS js FROM ev WHERE run_id = ${rid} AND (${where})`,
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

  // Test-only escape hatch: run a raw read query. Used by the lockstep test to
  // check DuckDB WHERE-admission directly.
  async raw(sql: string): Promise<Record<string, DuckDBValue>[]> {
    return this.rows(sql) as Promise<Record<string, DuckDBValue>[]>
  }

  private async nodeCounts(runId: number, filter: Filter = {}): Promise<Map<string, number>> {
    const { where, params } = filterToSql(filter)
    const scoped = `run_id = ${runId} AND (${where})`
    const rows = await this.rows(
      `WITH chains AS (SELECT ${CHAIN_SQL} AS chain FROM ev WHERE ${scoped})
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
      `WITH chains AS (SELECT ${CHAIN_SQL} AS chain FROM ev WHERE run_id = ${rid})
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
    this.activeRunId = undefined
    this.nextRunId = 1
  }
}

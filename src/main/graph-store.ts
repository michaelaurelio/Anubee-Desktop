import { openSync, readSync, closeSync } from 'node:fs'
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api'
import type { SyscallEvent } from '@shared/events'
import { filterToSql, type Filter } from '@shared/filter'
import { parseFrameSymbol } from '@shared/frame-symbol'
import { capSlice, type GraphNode, type GraphEdge, type GraphSlice } from '@shared/graph-shape'
import type { TableRow } from '@shared/table'

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

// Rebuild a node's kind/label/module from its id, mirroring chainOf's labelling
// exactly (native goes through the shared parseFrameSymbol). The SQL owns
// identity + counts; labelling stays in shared TS so it can never drift.
function nodeFromId(id: string, count: number): GraphNode {
  if (id.startsWith('java:')) return { id, kind: 'java', label: id.slice(5), module: null, count }
  if (id.startsWith('sys:')) return { id, kind: 'syscall', label: id.slice(4), module: null, count }
  const rest = id.slice(4) // 'nat:'
  const p = parseFrameSymbol(rest)
  const label = p.symbol ? `${p.symbol} (${p.module})` : (p.module ?? rest)
  return { id, kind: 'native', label, module: p.module, count }
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

export class GraphStore {
  private instance?: DuckDBInstance
  private con?: DuckDBConnection

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
  // heap. Returns the syscall count and the malformed-line count.
  async ingest(path: string, onProgress?: (pct: number) => void): Promise<{ eventCount: number; errors: number }> {
    await this.close()
    this.instance = await DuckDBInstance.create(':memory:')
    this.con = await this.instance.connect()

    const fmt = detectFormat(path)
    await this.conn().run(
      `CREATE TABLE ev AS SELECT * FROM read_json(${sqlStr(path)}, ` +
        `format='${fmt}', columns=${COLS}, maximum_object_size=20000000, ignore_errors=true)`,
    )

    // A malformed line becomes an all-null row (type NULL); a valid non-syscall
    // record keeps its type (e.g. 'lib'). Count them apart, keep only syscalls.
    const errors = await this.scalar("SELECT count(*) n FROM ev WHERE type IS NULL")
    const eventCount = await this.scalar("SELECT count(*) n FROM ev WHERE type = 'syscall'")
    await this.conn().run("DELETE FROM ev WHERE type IS DISTINCT FROM 'syscall'")

    onProgress?.(100)
    return { eventCount, errors }
  }

  // Master-table page, filtered in SQL.
  async table(filter: Filter, page: { limit: number; offset: number }): Promise<TableRow[]> {
    const limit = Math.max(0, Math.trunc(page.limit))
    const offset = Math.max(0, Math.trunc(page.offset))
    const { where, params } = filterToSql(filter)
    const rows = await this.rows(
      `SELECT id, tid, syscall, retval,
         (java_stack IS NOT NULL AND len(java_stack) > 0) AS hasJava,
         java_stack[1] AS topJava,
         backtrace[1].symbol AS topNative
       FROM ev WHERE ${where}
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
  async slice(filter: Filter = {}, cap?: number): Promise<GraphSlice> {
    const { where, params } = filterToSql(filter)
    const cte = `WITH chains AS (SELECT id AS eid, ${CHAIN_SQL} AS chain FROM ev WHERE ${where})`

    const nodeRows = await this.rows(
      `${cte} SELECT nid, count(*) AS c FROM (SELECT unnest(chain) AS nid FROM chains) GROUP BY nid`,
      params,
    )
    const edgeRows = await this.rows(
      `${cte} SELECT chain[i] AS src, chain[i + 1] AS tgt, count(*) AS c
       FROM chains, range(1, len(chain)) AS t(i) GROUP BY src, tgt`,
      params,
    )
    const eventCount = await this.scalar(`SELECT count(*) AS n FROM ev WHERE ${where}`, params)

    const nodes: GraphNode[] = nodeRows.map(r => nodeFromId(r.nid as string, Number(r.c)))
    const edges: GraphEdge[] = edgeRows.map(r => {
      const source = r.src as string
      const target = r.tgt as string
      return { id: `${source}=>${target}`, source, target, count: Number(r.c) }
    })
    return capSlice(nodes, edges, eventCount, cap)
  }

  // One raw record, reconstructed as a plain SyscallEvent via DuckDB's to_json.
  // `id` is an internal integer, safe to inline.
  async eventById(id: number): Promise<SyscallEvent | undefined> {
    const rows = await this.rows(`SELECT to_json(ev) AS js FROM ev WHERE id = ${Math.trunc(id)}`)
    if (rows.length === 0) return undefined
    return JSON.parse(rows[0].js as string) as SyscallEvent
  }

  async close(): Promise<void> {
    this.con?.closeSync()
    this.instance?.closeSync()
    this.con = undefined
    this.instance = undefined
  }
}

import { openSync, readSync, closeSync } from 'node:fs'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import type { SyscallEvent } from '@shared/events'
import type { Filter } from '@shared/filter'

export interface TableRow {
  id: number
  tid: number
  syscall: string
  retval: number | null
  hasJava: boolean
  topJava: string | null
  topNative: string | null
}

// Explicit read_json schema so DuckDB never mis-infers the nested/heterogeneous
// fields. Extends the ARES host store's schema (tools/ares-mcp/trace_store.py)
// with `type`, `stack_id`, and `java_stack` — the last is the RASP bridge this
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

  private async rows(sql: string): Promise<Record<string, unknown>[]> {
    const r = await this.conn().run(sql)
    return (await r.getRowObjects()) as Record<string, unknown>[]
  }

  private async scalar(sql: string): Promise<number> {
    const rows = await this.rows(sql)
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

  // Master-table page. `filter` is accepted now; the filter→SQL translation is
  // wired in Task 7 (today every row matches).
  async table(_filter: Filter, page: { limit: number; offset: number }): Promise<TableRow[]> {
    const limit = Math.max(0, Math.trunc(page.limit))
    const offset = Math.max(0, Math.trunc(page.offset))
    const rows = await this.rows(
      `SELECT id, tid, syscall, retval,
         (java_stack IS NOT NULL AND len(java_stack) > 0) AS hasJava,
         java_stack[1] AS topJava,
         backtrace[1].symbol AS topNative
       FROM ev WHERE TRUE
       ORDER BY id
       LIMIT ${limit} OFFSET ${offset}`,
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

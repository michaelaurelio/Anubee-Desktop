// One master-table row: a syscall event summarised for the list view. Shared
// boundary type between the DuckDB store (produces it) and the renderer table +
// row->subgraph selection (consumes it).
export interface TableRow {
  id: number
  tid: number
  engine: 'syscall' | 'func'
  // syscall rows:
  syscall: string
  retval: number | null
  hasJava: boolean
  topJava: string | null
  topNative: string | null
  arg: string
  // funcs rows:
  fn?: string
  caller?: string | null
  elapsed?: number | null
}

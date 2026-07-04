// One master-table row: a syscall event summarised for the list view. Shared
// boundary type between the DuckDB store (produces it) and the renderer table +
// row->subgraph selection (consumes it).
export interface TableRow {
  id: number
  tid: number
  syscall: string
  retval: number | null
  hasJava: boolean
  topJava: string | null
  topNative: string | null
}

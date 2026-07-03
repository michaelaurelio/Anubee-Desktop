// The filter grammar shared by the master table and the graph slice.
// This task (5) ships only the type; `filterToSql` is added in Task 7.
export interface Filter {
  syscall?: string
  tid?: number
  hasJavaStack?: boolean
  library?: string
  text?: string
}

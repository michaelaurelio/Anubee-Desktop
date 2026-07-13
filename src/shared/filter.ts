// The filter grammar shared by the master table and the graph slice.
export interface Filter {
  syscall?: string
  tid?: number
  hasJavaStack?: boolean
  library?: string
  text?: string
  module?: string
  symbol?: string
}

// Translate a Filter into a parameterised SQL WHERE fragment over the `ev`
// table. User text is always bound (positional `?`), never interpolated, so a
// filter string cannot inject SQL. All present fields AND together; an empty
// filter is `TRUE`.
export function filterToSql(f: Filter): { where: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []

  if (f.syscall) {
    clauses.push('syscall ILIKE ?')
    params.push(`%${f.syscall}%`)
  }
  if (f.module) {
    clauses.push('module ILIKE ?')
    params.push(`%${f.module}%`)
  }
  if (f.symbol) {
    clauses.push('symbol ILIKE ?')
    params.push(`%${f.symbol}%`)
  }
  if (f.tid !== undefined) {
    clauses.push('tid = ?')
    params.push(f.tid)
  }
  if (f.hasJavaStack !== undefined) {
    const nonEmpty = '(java_stack IS NOT NULL AND len(java_stack) > 0)'
    clauses.push(f.hasJavaStack ? nonEmpty : `NOT ${nonEmpty}`)
  }
  if (f.library) {
    // Any backtrace frame whose parsed module (offset stripped, part before the
    // first '!', bare-address frames excluded) matches the substring.
    clauses.push(
      "len(list_filter(list_transform(backtrace, b -> b.symbol), " +
        "s -> NOT (starts_with(s, '0x') AND NOT contains(s, '!')) " +
        "AND split_part(regexp_replace(s, '\\+0x[0-9a-fA-F]+$', ''), '!', 1) ILIKE ?)) > 0",
    )
    params.push(`%${f.library}%`)
  }
  if (f.text) {
    clauses.push(
      '(syscall ILIKE ? ' +
        'OR len(list_filter(coalesce(java_stack, []), x -> x ILIKE ?)) > 0 ' +
        'OR len(list_filter(list_transform(backtrace, b -> b.symbol), s -> s ILIKE ?)) > 0)',
    )
    const like = `%${f.text}%`
    params.push(like, like, like)
  }

  return { where: clauses.length ? clauses.join(' AND ') : 'TRUE', params }
}

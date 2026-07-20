import type { RaspCategory } from './project-store'

export interface TagTargets {
  syscalls: string[]    // from sys:<name> tags
  natFrames: string[]   // "mod!sym" from nat:<mod>!<sym> tags
  javaMethods: string[] // cleaned method from java:<method> tags
}

export interface Filter {
  syscall?: string
  tid?: number
  hasJavaStack?: boolean   // java.exist
  library?: string         // stack.lib
  module?: string          // fn.lib
  symbol?: string          // fn.sym
  text?: string
  id?: number              // id:N or lower bound of id:A-B
  idMax?: number           // upper bound of id:A-B
  javaMethod?: string      // java.method
  stackSymbol?: string     // stack.sym
  tagged?: 'yes' | 'no'    // tag.exist
  tagName?: RaspCategory   // tag.name
  tagTargets?: TagTargets  // injected by the renderer when tagged/tagName is set
}

// The offset suffix graph-shape strips to form nat:/java: node ids. Kept in sync
// with graph-shape's JAVA_DEXPC so a live frame matches a stored tag target.
const OFFSET_STRIP = "regexp_replace(%s, '\\+0x[0-9a-fA-F]+$', '')"

// Build the bounded tag predicate from injected target buckets. Empty buckets
// contribute nothing; an all-empty set is FALSE (a record can reach no target).
function tagPredicate(tt: { syscalls: string[]; natFrames: string[]; javaMethods: string[] },
                      params: unknown[]): string {
  const ors: string[] = []
  if (tt.syscalls.length) {
    ors.push(`syscall IN (${tt.syscalls.map(() => '?').join(', ')})`)
    params.push(...tt.syscalls)
  }
  if (tt.natFrames.length) {
    const strip = OFFSET_STRIP.replace('%s', 's')
    ors.push(
      `len(list_filter(list_transform(backtrace, b -> b.symbol), ` +
        `s -> NOT (starts_with(s, '0x') AND NOT contains(s, '!')) ` +
        `AND ${strip} IN (${tt.natFrames.map(() => '?').join(', ')}))) > 0`,
    )
    params.push(...tt.natFrames)
  }
  if (tt.javaMethods.length) {
    const strip = OFFSET_STRIP.replace('%s', 'j')
    ors.push(
      `len(list_filter(coalesce(java_stack, []), ` +
        `j -> ${strip} IN (${tt.javaMethods.map(() => '?').join(', ')}))) > 0`,
    )
    params.push(...tt.javaMethods)
  }
  return ors.length ? `(${ors.join(' OR ')})` : 'FALSE'
}

// Translate a Filter into a parameterised SQL WHERE fragment over the `ev`
// table. User text is always bound (positional `?`), never interpolated, so a
// filter string cannot inject SQL. All present fields AND together; an empty
// filter is `TRUE`.
export function filterToSql(f: Filter): { where: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []

  if (f.tagged || f.tagName) {
    const tt = f.tagTargets ?? { syscalls: [], natFrames: [], javaMethods: [] }
    const pred = tagPredicate(tt, params)
    clauses.push(f.tagged === 'no' ? `NOT ${pred}` : pred)
  }
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
  if (f.id !== undefined) {
    if (f.idMax !== undefined) {
      clauses.push('id BETWEEN ? AND ?')
      params.push(f.id, f.idMax)
    } else {
      clauses.push('id = ?')
      params.push(f.id)
    }
  }
  if (f.javaMethod) {
    clauses.push('len(list_filter(coalesce(java_stack, []), x -> x ILIKE ?)) > 0')
    params.push(`%${f.javaMethod}%`)
  }
  if (f.stackSymbol) {
    clauses.push('len(list_filter(list_transform(backtrace, b -> b.symbol), s -> s ILIKE ?)) > 0')
    params.push(`%${f.stackSymbol}%`)
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
        'OR len(list_filter(list_transform(backtrace, b -> b.symbol), s -> s ILIKE ?)) > 0 ' +
        "OR coalesce(array_to_string(args, ' '), '') ILIKE ? " +
        "OR coalesce(array_to_string(map_values(string_args), ' '), '') ILIKE ? " +
        "OR coalesce(array_to_string(map_values(fd_args), ' '), '') ILIKE ? " +
        "OR coalesce(array_to_string(map_values(decoded_args), ' '), '') ILIKE ? " +
        "OR coalesce(array_to_string(map_values(sock_args), ' '), '') ILIKE ? " +
        "OR coalesce(array_to_string(map_values(out_args), ' '), '') ILIKE ?)",
    )
    const like = `%${f.text}%`
    params.push(like, like, like, like, like, like, like, like, like)
  }

  return { where: clauses.length ? clauses.join(' AND ') : 'TRUE', params }
}

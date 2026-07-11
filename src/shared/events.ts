// Event-schema types, verified against ../ARES/src/syscalls/syscalls.c json_emit
// (L603-689). Field names are the contract - the schema-drift test (Task 4)
// guards them. Do not rename without updating the contract.

export interface BacktraceFrame {
  frame: number
  addr: string
  symbol: string
  java?: string
}

export interface SyscallEvent {
  type: 'syscall'
  id: number
  pid: number
  tid: number
  syscall_nr: number
  syscall: string
  args: string[]
  retval: number | null
  string_args: Record<string, string>
  fd_args: Record<string, string>
  decoded_args: Record<string, string>
  sock_addr?: string
  // A CFI stack-snapshot id (u64). Emitted as a JSON number that exceeds JS's
  // safe-integer range, so it is carried as a string to preserve every bit -
  // it is an opaque key, never a quantity to compute with.
  stack_id?: string
  java_stack?: string[]
  backtrace: BacktraceFrame[]
}

// The end-of-run `coverage` summary ARES emits under `--snapshot`: how many stack
// snapshots were taken/truncated and where the CFI unwinder stopped. Informational
// only - retained at ingest (EPIC A) but not graph data; vendored here so it is a
// known record type rather than an opaque UnknownEvent.
export interface CoverageEvent {
  type: 'coverage'
  engine: string
  snaps: { total: number; truncated: number }
  cfi: { walks: number; stops: Record<string, number> }
}

// `ares funcs` native call/return records - verified against
// ../ARES/src/funcs/funcs_emit.c (funcs_emit_call/funcs_emit_return). Unlike
// SyscallEvent's backtrace (caller frames only), FuncEvent.backtrace's frame 0
// is the called function itself (module/symbol/entry_addr name it directly).
export interface FuncEvent {
  type: 'call' | 'return'
  pid: number
  tid: number
  module: string
  symbol: string
  entry_addr: string
  backtrace: BacktraceFrame[]
  retval?: number // return only
  elapsed_ns?: number // return only
}

// `ares correlate` span-gated func->syscall correlation records - verified
// against ../ARES/src/correlate/corr_emit.c. All three share a `span` id
// (correlate's stack-based call tracking key) plus a `type` string that
// collides with another engine's record of the same name:
//   - CorrelateSyscallEvent's `type:'syscall'` collides with SyscallEvent's.
//   - CorrelateReturnEvent's `type:'return'` collides with FuncEvent's (emitted
//     when correlate is run with `--returns`, a real, non-dead flag).
// `span` is always set on correlate's own records and never set on the main
// syscalls/funcs engines' - that's the disambiguator graph-store.ts scopes on
// (`span IS NULL` for syscalls/funcs, `span IS NOT NULL` for correlate).
export interface CorrelateFuncEvent {
  type: 'func' // correlate's span-open record; unrelated to FuncEvent's 'call'/'return'
  span: number
  parent_span: number
  pid: number
  tid: number
  // No symbol/module - correlate's span-open record only carries the raw
  // address (a known limitation; see EPIC A Phase 3 plan notes).
  entry_addr: string
  args: string[]
}

export interface CorrelateSyscallEvent {
  type: 'syscall'
  span: number
  pid: number
  tid: number
  nr: number
  syscall: string
  args: string[]
  decoded: string[] // parallel to args; empty string per slot with no decode
}

export interface CorrelateReturnEvent {
  type: 'return'
  span: number
  pid: number
  tid: number
  entry_addr: string
  retval: string // hex string (unlike FuncEvent.retval, a signed number)
  elapsed_ns: number
}

export type CorrelateEvent = CorrelateFuncEvent | CorrelateSyscallEvent | CorrelateReturnEvent

// Any other non-syscall record (e.g. "lib", "unlib", "stack") is kept but opaque.
export interface UnknownEvent {
  type: string
  [k: string]: unknown
}

export type TraceEvent = SyscallEvent | CoverageEvent | FuncEvent | CorrelateEvent | UnknownEvent

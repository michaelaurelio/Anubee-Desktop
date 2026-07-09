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
// only - the store drops it at ingest (non-syscall); vendored here so it is a
// known record type rather than an opaque UnknownEvent.
export interface CoverageEvent {
  type: 'coverage'
  engine: string
  snaps: { total: number; truncated: number }
  cfi: { walks: number; stops: Record<string, number> }
}

// Any other non-syscall record (e.g. "lib", "unlib", "stack") is kept but opaque.
export interface UnknownEvent {
  type: string
  [k: string]: unknown
}

export type TraceEvent = SyscallEvent | CoverageEvent | UnknownEvent

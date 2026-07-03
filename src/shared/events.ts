// Event-schema types, verified against ../ARES/src/syscalls/syscalls.c json_emit
// (L603-689). Field names are the contract — the schema-drift test (Task 4)
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
  stack_id?: number
  java_stack?: string[]
  backtrace: BacktraceFrame[]
}

// Any non-syscall record (e.g. "lib", "stack") is kept but left opaque.
export interface UnknownEvent {
  type: string
  [k: string]: unknown
}

export type TraceEvent = SyscallEvent | UnknownEvent

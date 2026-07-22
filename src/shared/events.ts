// Event-schema types, verified against ../Anubee/src/syscalls/syscalls.c json_emit
// (L603-689). Field names are the contract - the schema-drift test (Task 4)
// guards them. Do not rename without updating the contract.

export interface BacktraceFrame {
  frame: number
  addr: string
  symbol: string
  java?: string
}

// One frame of a cfi_stack record's ordered CFI walk. `kind` tags the frame so
// the graph can place managed vs native vs the interpreter boundary in true order
// - verified against ../Anubee/src/common/symbolize.c anubee_emit_cfi_stack_json.
export interface CfiFrame {
  frame: number
  addr: string
  symbol: string
  kind: 'native' | 'managed' | 'interp' | 'jni-trampoline'
}

// A `cfi_stack` record from the `<run>.jsonl.stacks` sidecar: the full ordered
// walk for one stack_id (innermost-first). Interpreted methods appear inline as
// kind:'interp' frames with addr '0x0'; the interpreter entry machinery is
// kind:'interp' with a real addr.
export interface CfiStackEvent {
  type: 'cfi_stack'
  pid: number
  tid: number
  stack_id?: string
  cfi_backtrace: CfiFrame[]
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

// The end-of-run `coverage` summary Anubee emits: a per-engine health record,
// not exclusive to `--snapshot`. Informational only - retained at ingest
// (EPIC A) but not graph data; vendored here so it is a known record type
// rather than an opaque UnknownEvent. Verified against
// ../Anubee/src/common/coverage.c (anubee_coverage_report / cov_build_json),
// which writes three distinct shapes - every field below is optional because
// each one is behind its own `if` in the emitter, so only the signals that
// actually fired are present on any given record:
//  - exempt (`exempt:true`): the engine has no coverage surface at all (lib,
//    dump). `reason` is the only informative field.
//  - clean (`clean:true`): no degradation signal fired. `returns` still
//    appears when the engine runs in returns mode, degraded or not.
//  - degraded (neither exempt nor clean): any mix of snaps/cfi/drops/etc,
//    whichever ones fired.
export interface CoverageEvent {
  type: 'coverage'
  engine: string
  exempt?: true
  reason?: string
  clean?: true
  snaps?: { total: number; truncated: number }
  cfi?: { walks: number; stops: Record<string, number> }
  drops?: { ring: number; queue: number }
  managed_naming_off?: true
  prearm_drops?: number
  depth_capped?: number
  decode_partial?: true
  returns?: { spans: number; captured: number }
}

// `anubee funcs` native call/return records - verified against
// ../Anubee/src/funcs/funcs_emit.c (funcs_emit_call/funcs_emit_return). Unlike
// SyscallEvent's backtrace (caller frames only), FuncEvent.backtrace's frame 0
// is the called function itself (module/symbol/entry_addr name it directly).
export interface FuncEvent {
  type: 'call' | 'return'
  id: number
  stack_id?: string
  pid: number
  tid: number
  ppid?: number
  module: string
  symbol: string
  entry_addr?: string // call only
  offset?: number
  args?: string[]
  string_args?: Record<string, string>
  fd_args?: Record<string, string>
  sock_args?: Record<string, string>
  backtrace: BacktraceFrame[]
  java_stack?: string[]
  // From the paired `return` (shared id), merged onto the call record for display:
  retval?: number
  elapsed_ns?: number
  out_args?: Record<string, string>
}

// Any other non-syscall record (e.g. "lib", "unlib", "stack") is kept but opaque.
export interface UnknownEvent {
  type: string
  [k: string]: unknown
}

export type TraceEvent = SyscallEvent | CoverageEvent | FuncEvent | CfiStackEvent | UnknownEvent

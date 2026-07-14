// Vendored contract for the ARES JSONL event schema - the coupling surface
// (design §4). These are the top-level keys the `syscall` record emits, read
// from ../ARES/src/syscalls/syscalls.c `json_emit`. The schema-drift test
// (tests/schema-drift.test.ts) fails when the emitter stops emitting one of
// these, so a tracer-side rename can't silently break the parser.
//
// Verified against ARES commit:
export const ARES_COMMIT = 'aefb1508dd790a8c3385c0ed4432ced0ae3eed6d'

// Top-level keys on a `syscall` record. `sock_addr`, `stack_id`, `java_stack`
// are conditional but still appear in the emitter source.
export const SYSCALL_KEYS = [
  'type',
  'id',
  'pid',
  'tid',
  'syscall_nr',
  'syscall',
  'args',
  'retval',
  'string_args',
  'fd_args',
  'decoded_args',
  'sock_addr',
  'stack_id',
  'java_stack',
  'backtrace',
] as const

// Keys on each object in the `backtrace` array.
export const BACKTRACE_KEYS = ['frame', 'addr', 'symbol', 'java'] as const

// Funcs record keys the app consumes, guarded against ../ARES/src/funcs/funcs_emit.c.
// `stack_id` is consumed: Phase 2 joins funcs `call` rows to the cfi_stack sidecar by it.
// `caller_addr` is excluded for a different reason: it exists on the internal
// `struct event` (funcs.h) and is printed to the human console (funcs.c
// human_detail), but funcs_emit.c never serializes it into the JSON record - it
// is not part of the JSONL schema this app consumes.
export const FUNCS_KEYS = [
  'type', 'id', 'pid', 'tid', 'ppid', 'module', 'symbol', 'entry_addr', 'offset',
  'args', 'string_args', 'fd_args', 'sock_args', 'java_stack', 'backtrace', 'stack_id',
  'retval', 'elapsed_ns', 'out_args',
] as const

// Top-level keys on a `cfi_stack` record, read from ../ARES/src/common/symbolize.c
// (ares_emit_cfi_stack_json). Emitted to the `<run>.jsonl.stacks` sidecar.
export const CFI_STACK_KEYS = ['type', 'pid', 'tid', 'stack_id', 'cfi_backtrace'] as const

// Keys on each object in the `cfi_backtrace` array. `kind` is the interleaving
// discriminator (native / managed / interp / jni-trampoline).
export const CFI_BACKTRACE_KEYS = ['frame', 'addr', 'symbol', 'kind'] as const

// `lib` / `unlib` records - ares_libtrace_emit_lib / _emit_unlib in
// ../ARES/src/common/lib_trace.c. Consumed by GraphStore.libTable + the live
// [lib] line parser.
export const LIB_KEYS = ['type', 'pid', 'tid', 'ppid', 'library', 'start', 'end', 'pgoff', 'inode', 'soname'] as const
export const UNLIB_KEYS = ['type', 'pid', 'tid', 'start', 'end'] as const
// `dump` manifest record - dump_emit_module in ../ARES/src/dump/dump_emit.c.
export const DUMP_KEYS = ['type', 'module', 'path', 'base', 'pid', 'raw'] as const

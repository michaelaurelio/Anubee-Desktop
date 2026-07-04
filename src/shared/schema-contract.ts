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

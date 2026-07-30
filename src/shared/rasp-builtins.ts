import type { Rule } from './rasp-rules'
import { coerceRules } from './rasp-rules'

// Built-in rules as raw specs, validated at module load. A malformed built-in
// throws here rather than disappearing quietly, and defaults (enabled, correlate,
// maxGap, mode, minOccurrences) are supplied by validateRule.
export const BUILTIN_SPECS: unknown[] = [
  { id: 'dbg-ptrace-attach', category: 'debugger', confidence: 0.7,
    rationale: 'ptrace(PTRACE_ATTACH) attach-probe - anti-debug self/other attach',
    steps: [{ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0x10' }] },
  { id: 'dbg-ptrace-traceme', category: 'debugger', confidence: 0.9,
    rationale: 'ptrace(PTRACE_TRACEME) - classic anti-debug self-attach',
    steps: [{ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0x0' }] },
  { id: 'dbg-status-open', category: 'debugger', confidence: 0.6,
    rationale: 'open of /proc/self/status - likely TracerPid debugger check',
    steps: [{ syscalls: ['openat', 'newfstatat'], field: 'string_args', op: 'path_matches', value: '/proc/self/status$' }] },
  { id: 'dbg-status-read', category: 'debugger', confidence: 0.6,
    rationale: 'read of /proc/self/status - likely TracerPid debugger check',
    steps: [{ syscalls: ['read'], field: 'fd_args', op: 'equals', value: '/proc/self/status' }] },
  { id: 'hook-maps', category: 'hook', confidence: 0.4,
    rationale: 'read of /proc/self/maps - hook/injection scan; weak on its own, see hook-frida-scan',
    steps: [{ syscalls: ['openat', 'newfstatat'], field: 'string_args', op: 'path_matches', value: '/proc/self/maps$' }] },
  { id: 'hook-frida-sock', category: 'hook', confidence: 0.9,
    rationale: 'connect to a frida control socket - dynamic-instrumentation probe',
    steps: [{ syscalls: ['connect'], field: 'sock_addr', op: 'path_matches', value: 'frida' }] },
  { id: 'hook-frida-scan', category: 'hook', confidence: 0.95,
    rationale: 'maps walk followed by a frida artefact probe - dynamic-instrumentation scan',
    correlate: 'module+tid', maxGap: 200,
    steps: [
      { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '/proc/self/maps$' },
      { syscalls: ['openat', 'newfstatat', 'faccessat', 'access', 'readlinkat'], field: 'string_args',
        op: 'path_matches', value: 'frida|gum-js-loop|re\\.frida|linjector' },
    ] },
  { id: 'root-paths', category: 'root', confidence: 0.85,
    rationale: 'access of a root-indicator path (su/magisk/busybox/xbin/sbin/adb)',
    steps: [{ syscalls: ['openat', 'access', 'newfstatat', 'faccessat'], field: 'string_args', op: 'path_matches',
      value: '(^|/)su$|magisk|busybox|/system/xbin|/sbin(/|$)|/data/adb' }] },
  { id: 'root-selinux', category: 'root', confidence: 0.8,
    rationale: 'read of /sys/fs/selinux/enforce - SELinux-posture / root tell',
    steps: [{ syscalls: ['openat', 'newfstatat', 'faccessat'], field: 'string_args', op: 'path_matches', value: '/sys/fs/selinux/enforce$' }] },
  { id: 'root-ksu-prctl', category: 'root', confidence: 0.9,
    rationale: 'prctl(0xdeadbeef) - KernelSU magic prctl probe',
    steps: [{ syscalls: ['prctl'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0xdeadbeef' }] },
]

export const BUILTIN_RULES: Rule[] = (() => {
  const { rules, errors } = coerceRules(BUILTIN_SPECS, 'builtin')
  if (errors.length > 0) throw new Error(`malformed built-in rule: ${errors.join('; ')}`)
  return rules
})()

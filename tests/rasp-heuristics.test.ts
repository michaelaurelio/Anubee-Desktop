import { describe, it, expect } from 'vitest'
import { compileWhere, scoreWith, aggregate, normalizeFdValue, BUILTIN_RULES, type Rule } from '../src/shared/rasp-heuristics'
import type { SyscallEvent } from '../src/shared/events'

const base: SyscallEvent = {
  type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 0, syscall: 'openat',
  args: [], retval: 0, string_args: {}, fd_args: {}, decoded_args: {},
  backtrace: [{ frame: 0, addr: '0x1', symbol: 'libexample.so!check_su+0x10' }],
}
const rules = BUILTIN_RULES
const cats = (e: SyscallEvent) => scoreWith(rules, e).map(s => s.category).sort()

describe('scoreWith over the built-in set', () => {
  it('flags ptrace ATTACH (0x10) as debugger', () => {
    expect(cats({ ...base, syscall: 'ptrace', args: ['0x10'], backtrace: [] })).toContain('debugger')
  })
  it('flags ptrace TRACEME (0x0) as debugger', () => {
    expect(cats({ ...base, syscall: 'ptrace', args: ['0x0'], backtrace: [] })).toContain('debugger')
  })
  it('flags an openat on an su path as root, targeting the nearest native frame', () => {
    const s = scoreWith(rules, { ...base, syscall: 'openat', string_args: { '1': '/system/bin/su' } })
    expect(s.find(x => x.category === 'root')!.target).toBe('nat:libexample.so!check_su')
  })

  it('targets the innermost NON-system native block, skipping the libc wrapper', () => {
    // backtrace[0] = innermost (libc syscall wrapper); the app's RASP block is
    // one frame out; libart is outermost. The suggestion must name the app block.
    const s = scoreWith(rules, {
      ...base, syscall: 'openat', string_args: { '1': '/system/bin/su' },
      backtrace: [
        { frame: 0, addr: '0x1', symbol: 'libc.so!__openat+0x8' },
        { frame: 1, addr: '0x2', symbol: 'librasp.so!detect_root+0x4c' },
        { frame: 2, addr: '0x3', symbol: 'libart.so!_ZN3artEv+0x10' },
      ],
    })
    expect(s.find(x => x.category === 'root')!.target).toBe('nat:librasp.so!detect_root')
  })

  it('falls back to the innermost native when the whole path is system libs', () => {
    const s = scoreWith(rules, {
      ...base, syscall: 'openat', string_args: { '1': '/system/bin/su' },
      backtrace: [
        { frame: 0, addr: '0x1', symbol: 'libc.so!__openat+0x8' },
        { frame: 1, addr: '0x2', symbol: 'libart.so!_ZN3artEv+0x10' },
      ],
    })
    expect(s.find(x => x.category === 'root')!.target).toBe('nat:libc.so!__openat')
  })
  it('flags magisk, busybox, and /data/adb paths as root', () => {
    for (const p of ['/sbin/magisk', '/system/xbin/busybox', '/data/adb/magisk']) {
      expect(cats({ ...base, syscall: 'access', string_args: { '1': p } })).toContain('root')
    }
  })
  it('flags /sys/fs/selinux/enforce as root', () => {
    expect(cats({ ...base, syscall: 'openat', string_args: { '1': '/sys/fs/selinux/enforce' } })).toContain('root')
  })
  it('flags prctl(0xdeadbeef) as root', () => {
    expect(cats({ ...base, syscall: 'prctl', args: ['0xdeadbeef'], backtrace: [] })).toContain('root')
  })
  it('flags openat /proc/self/status as debugger', () => {
    expect(cats({ ...base, syscall: 'openat', string_args: { '1': '/proc/self/status' } })).toContain('debugger')
  })
  it('flags read of /proc/self/status as debugger (real fd_args shape)', () => {
    expect(cats({ ...base, syscall: 'read', fd_args: { '0': 'fd=6 </proc/self/status>' },
                  backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] }))
      .toContain('debugger')
  })
  it('flags openat /proc/self/maps as hook', () => {
    expect(cats({ ...base, syscall: 'openat', string_args: { '1': '/proc/self/maps' } })).toContain('hook')
  })
  it('flags a connect to a frida socket as hook', () => {
    expect(cats({ ...base, syscall: 'connect', sock_addr: 'unix:@/frida-zymbiote-abc', backtrace: [] })).toContain('hook')
  })
  it('returns nothing for a benign event', () => {
    expect(scoreWith(rules, { ...base, syscall: 'openat', string_args: { '1': '/data/app/lib.so' } })).toEqual([])
  })
  it('does not flag connect to an unrelated socket', () => {
    expect(scoreWith(rules, { ...base, syscall: 'connect', sock_addr: 'unix:@/some-app', backtrace: [] })).toEqual([])
  })
})

describe('compileWhere', () => {
  it('emits an arg_hex_eq clause with both hex and decimal forms, 1-indexed', () => {
    const r: Rule = BUILTIN_RULES.find(x => x.id === 'root-ksu-prctl')!
    const w = compileWhere([r])
    expect(w).toContain("syscall IN ('prctl')")
    expect(w).toContain('args[1] IN')
    expect(w).toContain("'0xdeadbeef'")
    expect(w).toContain("'3735928559'") // 0xdeadbeef decimal
  })
  it('emits a map path_matches clause for string_args', () => {
    const r: Rule = BUILTIN_RULES.find(x => x.id === 'root-selinux')!
    const w = compileWhere([r])
    expect(w).toContain('map_values(string_args)')
    expect(w).toContain('regexp_matches')
  })
  it('emits a scalar clause for sock_addr', () => {
    const r: Rule = BUILTIN_RULES.find(x => x.id === 'hook-frida-sock')!
    const w = compileWhere([r])
    expect(w).toContain('regexp_matches(sock_addr')
    expect(w).not.toContain('map_values(sock_addr)')
  })
  it('escapes single quotes in a value', () => {
    const r: Rule = { id: 'q', category: 'custom', confidence: 0.5, rationale: '', enabled: true, source: 'global',
      match: { syscalls: ['openat'], field: 'string_args', op: 'equals', value: "a'b" } }
    expect(compileWhere([r])).toContain("'a''b'")
  })
  it('returns false for an empty rule list (matches nothing)', () => {
    expect(compileWhere([])).toBe('false')
  })
})

describe('aggregate (unchanged)', () => {
  it('collapses to one per target with summed occurrences and max confidence', () => {
    const a = { target: 'sys:ptrace', category: 'debugger' as const, confidence: 0.7, rationale: 'x', occurrences: 1 }
    const b = { target: 'sys:ptrace', category: 'debugger' as const, confidence: 0.9, rationale: 'y', occurrences: 1 }
    const out = aggregate([a, b])
    expect(out).toHaveLength(1)
    expect(out[0].occurrences).toBe(2)
    expect(out[0].confidence).toBe(0.9)
  })
})

describe('normalizeFdValue', () => {
  it('unwraps a resolved fd', () => {
    expect(normalizeFdValue('fd=6 </proc/self/status>')).toBe('/proc/self/status')
  })
  it('drops an unresolved fd (no path to match)', () => {
    expect(normalizeFdValue('fd=122')).toBeNull()
  })
  it('passes AT_FDCWD through', () => {
    expect(normalizeFdValue('AT_FDCWD')).toBe('AT_FDCWD')
  })
  it('passes a negative fd through', () => {
    expect(normalizeFdValue('-1')).toBe('-1')
  })
  it('unwraps a non-file descriptor', () => {
    expect(normalizeFdValue('fd=115 <pipe:[4230735]>')).toBe('pipe:[4230735]')
  })
})

import { describe, it, expect } from 'vitest'
import { matchSequences, compileWhere, validateRule, type Rule } from '../src/shared/rasp-heuristics'
import type { SyscallEvent } from '../src/shared/events'

const APP = [{ frame: 0, addr: '0x1000', symbol: 'libc.so!prctl+0x8' },
             { frame: 1, addr: '0x2100', symbol: 'libsentinel.so!chk+0x100' }]

export function ev(over: Partial<SyscallEvent> = {}): SyscallEvent {
  return {
    type: 'syscall', id: 1, pid: 100, tid: 100, syscall_nr: 0, syscall: 'prctl',
    args: [], retval: 0, string_args: {}, fd_args: {}, decoded_args: {}, backtrace: APP, ...over,
  } as SyscallEvent
}

function rule(over: Record<string, unknown>): Rule {
  const { rule: r, error } = validateRule({
    id: 't', category: 'debugger', confidence: 0.5, rationale: 'r', ...over,
  }, 'global')
  if (!r) throw new Error(error ?? 'invalid')
  return r
}

describe('decoded_args field', () => {
  const r = rule({ steps: [{ syscalls: ['prctl'], field: 'decoded_args', op: 'path_matches',
    value: 'PR_(SET|GET)_DUMPABLE|PR_SET_SECCOMP' }] })

  it('matches a decoded prctl request name', () => {
    expect(matchSequences([r], [ev({ decoded_args: { '0': 'PR_GET_DUMPABLE' } })]).hits).toHaveLength(1)
  })

  it('does not match an unrelated decoded name', () => {
    expect(matchSequences([r], [ev({ decoded_args: { '0': 'PR_SET_NAME' } })]).hits).toHaveLength(0)
  })

  it('compiles to a map_values clause over decoded_args', () => {
    expect(compileWhere([r])).toContain('map_values(decoded_args)')
  })

  it('path_matches compiles to regexp_matches in SQL', () => {
    const sqlClause = compileWhere([r])
    expect(sqlClause).toContain('regexp_matches')
    expect(sqlClause).toContain('map_values(decoded_args)')
  })

  it('equals operator matches exact decoded argument values', () => {
    const eqRule = rule({ steps: [{ syscalls: ['mprotect'], field: 'decoded_args', op: 'equals',
      value: 'PROT_READ|PROT_WRITE' }] })
    expect(matchSequences([eqRule], [ev({ syscall: 'mprotect', decoded_args: { '0': 'PROT_READ|PROT_WRITE' } })]).hits).toHaveLength(1)
  })

  it('equals operator does not match partial decoded argument values', () => {
    const eqRule = rule({ steps: [{ syscalls: ['mprotect'], field: 'decoded_args', op: 'equals',
      value: 'PROT_READ|PROT_WRITE' }] })
    expect(matchSequences([eqRule], [ev({ syscall: 'mprotect', decoded_args: { '0': 'PROT_READ' } })]).hits).toHaveLength(0)
  })

  it('equals operator compiles to list_contains in SQL', () => {
    const eqRule = rule({ steps: [{ syscalls: ['mprotect'], field: 'decoded_args', op: 'equals',
      value: 'PROT_READ|PROT_WRITE' }] })
    const sqlClause = compileWhere([eqRule])
    expect(sqlClause).toContain('list_contains')
    expect(sqlClause).toContain('map_values(decoded_args)')
  })
})

describe('arg_hex_in', () => {
  const r = rule({ category: 'debugger',
    steps: [{ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_in', argIndex: 0, value: '0x10 0x7 0x11' }] })

  it('matches any listed request code, in hex or decimal spelling', () => {
    for (const a of ['0x10', '0x7', '0x11', '7', '16', '17']) {
      expect(matchSequences([r], [ev({ syscall: 'ptrace', args: [a] })]).hits, a).toHaveLength(1)
    }
  })

  it('does not match an unlisted request code', () => {
    expect(matchSequences([r], [ev({ syscall: 'ptrace', args: ['0x0'] })]).hits).toHaveLength(0)
  })

  it('compiles to an IN clause carrying both spellings', () => {
    const sql = compileWhere([r])
    expect(sql).toContain("args[1] IN (")
    for (const lit of ["'0x10'", "'16'", "'0x7'", "'7'", "'0x11'", "'17'"]) expect(sql).toContain(lit)
  })

  it('rejects a non-hex element and a missing argIndex', () => {
    expect(validateRule({ id: 'x', category: 'debugger', confidence: 0.5, rationale: 'r',
      steps: [{ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_in', argIndex: 0, value: '0x10 nope' }] }, 'global').error)
      .toBe('arg_hex_in values must all be hex on x')
    expect(validateRule({ id: 'y', category: 'debugger', confidence: 0.5, rationale: 'r',
      steps: [{ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_in', value: '0x10' }] }, 'global').error)
      .toBe('arg_hex_in needs argIndex on y')
  })
})

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
})

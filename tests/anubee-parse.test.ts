import { describe, it, expect } from 'vitest'
import { parseLine, parseJsonl, isSyscall } from '@shared/anubee-parse'

const SYSCALL = {
  type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 56, syscall: 'openat',
  args: ['0xffffff9c', '0x7f00'], retval: 7, string_args: { '1': '/system/bin/su' },
  fd_args: {}, decoded_args: {}, stack_id: 42, java_stack: ['com.example.Sec.check'],
  backtrace: [{ frame: 0, addr: '0x7a00', symbol: 'libexample.so!check+0x10' }],
}
const SYSCALL_LINE = JSON.stringify(SYSCALL)

describe('parseLine', () => {
  it('parses a syscall record with all fields', () => {
    const { event, error } = parseLine(SYSCALL_LINE, 1)
    expect(error).toBeUndefined()
    expect(event).toBeDefined()
    expect(isSyscall(event!)).toBe(true)
    if (event && isSyscall(event)) {
      expect(event.syscall).toBe('openat')
      expect(event.java_stack).toEqual(['com.example.Sec.check'])
      expect(event.backtrace[0].symbol).toBe('libexample.so!check+0x10')
    }
  })

  it('keeps an unknown record type without dropping it', () => {
    const { event, error } = parseLine(JSON.stringify({ type: 'lib', pid: 1, library: 'libexample.so' }), 5)
    expect(error).toBeUndefined()
    expect(event!.type).toBe('lib')
    expect(isSyscall(event!)).toBe(false)
  })

  it('reports a malformed line as an error, does not throw', () => {
    const { event, error } = parseLine('{not json}', 9)
    expect(event).toBeUndefined()
    expect(error).toBeDefined()
    expect(error!.line).toBe(9)
  })

  it('reports an object missing a string "type" as an error', () => {
    const { event, error } = parseLine(JSON.stringify({ id: 1 }), 3)
    expect(event).toBeUndefined()
    expect(error!.line).toBe(3)
  })
})

describe('parseJsonl', () => {
  it('parses lines, skips blanks, collects malformed with correct line numbers', () => {
    const text = SYSCALL_LINE + '\n\n{not json}\n'
    const r = parseJsonl(text)
    expect(r.events).toHaveLength(1)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].line).toBe(3)
  })

  it('tolerates a truncated final line (interrupted run)', () => {
    const text = SYSCALL_LINE + '\n' + '{"type":"syscall","id":2,"pi'
    const r = parseJsonl(text)
    expect(r.events).toHaveLength(1)
    expect(r.errors).toHaveLength(1)
  })
})

import { describe, it, expect } from 'vitest'
import { CAPABILITIES, capById, validateInputs } from '../src/shared/tracer-caps'

describe('tracer-caps registry', () => {
  it('exposes the seven engines with correct output kinds', () => {
    expect(CAPABILITIES.map(c => c.id).sort()).toEqual(
      ['correlate', 'dump', 'funcs', 'lib', 'mod', 'syscalls', 'trace'])
    expect(capById('syscalls')!.outputKind).toBe('jsonl')
    expect(capById('funcs')!.outputKind).toBe('jsonl')
    expect(capById('correlate')!.outputKind).toBe('jsonl')
    expect(capById('trace')!.outputKind).toBe('jsonl')
    expect(capById('lib')!.outputKind).toBe('stdout')
    expect(capById('dump')!.outputKind).toBe('artifact')
    expect(capById('mod')!.outputKind).toBe('stdout')
    expect(capById('correlate')!.loud).toBe(true)
    expect(capById('trace')!.loud).toBe(true)
  })

  it('builds syscalls argv with library filter', () => {
    expect(capById('syscalls')!.buildArgv({ pkg: 'com.android.deskclock', lib: 'libc.so' }))
      .toEqual(['syscalls', '-P', 'com.android.deskclock', '-l', 'libc.so'])
  })

  it('builds syscalls argv with capture-all + syscall csv', () => {
    expect(capById('syscalls')!.buildArgv({ pkg: 'com.android.deskclock', all: true, syscalls: 'openat,read' }))
      .toEqual(['syscalls', '-P', 'com.android.deskclock', '-a', '-s', 'openat,read'])
  })

  it('builds funcs argv with a spec path', () => {
    expect(capById('funcs')!.buildArgv({ pkg: 'com.android.deskclock', spec: 'common-file.spec' }))
      .toEqual(['funcs', '-P', 'com.android.deskclock', '-F', '/data/local/tmp/specs/common-file.spec'])
  })

  it('builds lib and dump positional argv', () => {
    expect(capById('lib')!.buildArgv({ pkg: 'com.android.deskclock' }))
      .toEqual(['lib', 'com.android.deskclock'])
    expect(capById('dump')!.buildArgv({ pkg: 'com.android.deskclock', pattern: 'lib<example>.so' }))
      .toEqual(['dump', 'com.android.deskclock', 'lib<example>.so'])
  })

  it('builds mod argv with an analyzer name', () => {
    expect(capById('mod')!.buildArgv({ analyzer: 'getprop', pkg: 'com.android.deskclock' }))
      .toEqual(['mod', 'getprop', '-P', 'com.android.deskclock'])
  })

  it('rejects missing required inputs', () => {
    expect(validateInputs(capById('syscalls')!, {})).toContain('package is required')
    expect(validateInputs(capById('dump')!, { pkg: 'com.android.deskclock' })).toContain('pattern is required')
  })

  it('accepts a valid input set', () => {
    expect(validateInputs(capById('syscalls')!, { pkg: 'com.android.deskclock', lib: 'libc.so' })).toEqual([])
  })
})

import { composeRunArg, outJsonlPath, DEVICE_BIN, STOP_ARG } from '../src/shared/tracer-caps'

describe('composeRunArg', () => {
  const syscalls = capById('syscalls')!
  const lib = capById('lib')!

  it('wraps a jsonl run in su -c + timeout and appends -o', () => {
    const arg = composeRunArg({
      cap: syscalls, vals: { pkg: 'com.android.deskclock', lib: 'libc.so' },
      timeoutSecs: 20, jsonlPath: outJsonlPath('20260707T101500'),
    })
    expect(arg).toBe(
      "su -c 'timeout -s INT -k 3 20 /data/local/tmp/ares syscalls -P com.android.deskclock " +
      "-l libc.so -o /data/local/tmp/ares-20260707T101500.jsonl'")
  })

  it('does not append -o for a stdout capability', () => {
    const arg = composeRunArg({ cap: lib, vals: { pkg: 'com.android.deskclock' }, timeoutSecs: 10 })
    expect(arg).toBe("su -c 'timeout -s INT -k 3 10 /data/local/tmp/ares lib com.android.deskclock'")
  })

  it('omits the timeout wrapper when timeoutSecs is unset (run until Stop)', () => {
    const arg = composeRunArg({ cap: lib, vals: { pkg: 'com.android.deskclock' } })
    expect(arg).toBe("su -c '/data/local/tmp/ares lib com.android.deskclock'")
  })

  it('exposes the fixed binary path and stop command', () => {
    expect(DEVICE_BIN).toBe('/data/local/tmp/ares')
    expect(STOP_ARG).toBe("su -c 'pkill -INT -f /data/local/tmp/ares'")
    expect(outJsonlPath('X')).toBe('/data/local/tmp/ares-X.jsonl')
  })
})

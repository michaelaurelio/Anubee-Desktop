import { describe, it, expect } from 'vitest'
import { CAPABILITIES, capById, validateInputs, fieldErrors, capNeedsSpec } from '../src/shared/tracer-caps'

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

  it('rejects syscalls with neither a library filter nor capture-all', () => {
    // ares errors "-l <lib-selector> is required (or use -a)" if given just -P.
    expect(validateInputs(capById('syscalls')!, { pkg: 'com.android.deskclock' }))
      .toContain('provide a library filter or check "capture all libraries"')
  })

  it('accepts syscalls with capture-all', () => {
    expect(validateInputs(capById('syscalls')!, { pkg: 'com.android.deskclock', all: true })).toEqual([])
  })

  it('rejects a token carrying a shell metacharacter or space', () => {
    // A single quote would close the su -c '...' body; a space would split the arg.
    expect(validateInputs(capById('syscalls')!, { pkg: 'com.app', lib: "libc.so'; rm -rf /" }))
      .toEqual(['library filter has unsupported characters (allowed: letters, digits, and . _ - / : , +)'])
    expect(validateInputs(capById('syscalls')!, { pkg: 'com.app', lib: 'lib c.so' }))
      .toContain('library filter has unsupported characters (allowed: letters, digits, and . _ - / : , +)')
  })

  it('accepts the real token punctuation (dots, comma-csv, slash, hyphen)', () => {
    expect(validateInputs(capById('syscalls')!, { pkg: 'com.android.deskclock', all: true, syscalls: 'openat,read' }))
      .toEqual([])
    expect(validateInputs(capById('funcs')!, { pkg: 'com.app', spec: 'common-file.spec' })).toEqual([])
  })

  it('adds the common tuning inputs only to syscalls/funcs/correlate', () => {
    const tuningKeys = ['bufmb', 'queuemb', 'verbose']
    for (const id of ['syscalls', 'funcs', 'correlate']) {
      const keys = capById(id)!.inputs.map(i => i.key)
      expect(keys).toEqual(expect.arrayContaining(tuningKeys))
      expect(capById(id)!.common).toBe(true)
    }
    for (const id of ['trace', 'lib', 'dump', 'mod']) {
      const keys = capById(id)!.inputs.map(i => i.key)
      expect(keys).not.toEqual(expect.arrayContaining(tuningKeys))
      expect(capById(id)!.common).toBeFalsy()
    }
  })

  it('marks the tuning inputs advanced with ares defaults', () => {
    const buf = capById('syscalls')!.inputs.find(i => i.key === 'bufmb')!
    const q = capById('syscalls')!.inputs.find(i => i.key === 'queuemb')!
    const v = capById('syscalls')!.inputs.find(i => i.key === 'verbose')!
    expect(buf).toMatchObject({ kind: 'int', default: 4, min: 1, advanced: true })
    expect(q).toMatchObject({ kind: 'int', default: 256, min: 1, advanced: true })
    expect(v).toMatchObject({ kind: 'bool', advanced: true })
  })
})

import { composeRunArg, outJsonlPath, outDumpDir, DEVICE_BIN, STOP_ARG } from '../src/shared/tracer-caps'

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

  it('appends -d <dumpDir> for an artifact (dump) capability', () => {
    const arg = composeRunArg({
      cap: capById('dump')!, vals: { pkg: 'com.android.deskclock', pattern: 'lib<example>.so' },
      timeoutSecs: 20, dumpDir: outDumpDir('20260707T101500'),
    })
    expect(arg).toBe(
      "su -c 'timeout -s INT -k 3 20 /data/local/tmp/ares dump com.android.deskclock " +
      "lib<example>.so -d /data/local/tmp/ares-dump-20260707T101500'")
    expect(outDumpDir('X')).toBe('/data/local/tmp/ares-dump-X')
  })
})

describe('fieldErrors', () => {
  const syscalls = capById('syscalls')!
  it('reports a required-empty field by key', () => {
    const { fields } = fieldErrors(syscalls, { all: true })
    expect(fields.pkg).toBe('is required')
  })
  it('reports an unsupported-character field by key', () => {
    const { fields } = fieldErrors(syscalls, { pkg: 'com bad', all: true })
    expect(fields.pkg).toMatch(/unsupported characters/)
  })
  it('reports the cross-field error in form, not fields', () => {
    const { fields, form } = fieldErrors(syscalls, { pkg: 'com.x' })
    expect(fields.pkg).toBeUndefined()
    expect(form).toEqual(['provide a library filter or check "capture all libraries"'])
  })
})

describe('capNeedsSpec', () => {
  it('is true for the spec engines', () => {
    for (const id of ['funcs', 'correlate', 'trace']) {
      expect(capNeedsSpec(capById(id)!)).toBe(true)
    }
  })
  it('is false for the non-spec engines', () => {
    for (const id of ['syscalls', 'lib', 'dump', 'mod']) {
      expect(capNeedsSpec(capById(id)!)).toBe(false)
    }
  })
})

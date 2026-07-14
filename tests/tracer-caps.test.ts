import { describe, it, expect } from 'vitest'
import { CAPABILITIES, capById, validateInputs, fieldErrors, capNeedsSpec } from '../src/shared/tracer-caps'

describe('tracer-caps registry', () => {
  it('exposes the five engines with correct output kinds', () => {
    expect(CAPABILITIES.map(c => c.id).sort()).toEqual(
      ['correlate', 'funcs', 'mod', 'syscalls', 'trace'])
    expect(capById('syscalls')!.outputKind).toBe('jsonl')
    expect(capById('funcs')!.outputKind).toBe('jsonl')
    expect(capById('correlate')!.outputKind).toBe('jsonl')
    expect(capById('trace')!.outputKind).toBe('jsonl')
    expect(capById('mod')!.outputKind).toBe('stdout')
    expect(capById('correlate')!.loud).toBe(true)
    expect(capById('trace')!.loud).toBe(true)
  })

  it('no longer exposes lib or dump as capture engines', () => {
    expect(capById('lib')).toBeUndefined()
    expect(capById('dump')).toBeUndefined()
    expect(CAPABILITIES.some(c => (c.outputKind as string) === 'artifact')).toBe(false)
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

  it('builds mod argv with an analyzer name', () => {
    expect(capById('mod')!.buildArgv({ analyzer: 'getprop', pkg: 'com.android.deskclock' }))
      .toEqual(['mod', 'getprop', '-P', 'com.android.deskclock'])
  })

  it('rejects missing required inputs', () => {
    expect(validateInputs(capById('syscalls')!, {})).toContain('package is required')
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
    for (const id of ['trace', 'mod']) {
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

  it('adds the --snapshot input to syscalls and funcs only', () => {
    for (const id of ['syscalls', 'funcs']) {
      expect(capById(id)!.inputs.map(i => i.key)).toContain('snapshot')
    }
    for (const id of ['correlate', 'trace', 'mod']) {
      expect(capById(id)!.inputs.map(i => i.key)).not.toContain('snapshot')
    }
    const snap = capById('syscalls')!.inputs.find(i => i.key === 'snapshot')!
    expect(snap).toMatchObject({ kind: 'bool', advanced: true })
  })

  it('emits --snapshot in syscalls/funcs argv only when checked', () => {
    expect(capById('syscalls')!.buildArgv({ pkg: 'com.android.deskclock', all: true, snapshot: true }))
      .toEqual(['syscalls', '-P', 'com.android.deskclock', '-a', '--snapshot'])
    expect(capById('syscalls')!.buildArgv({ pkg: 'com.android.deskclock', all: true }))
      .toEqual(['syscalls', '-P', 'com.android.deskclock', '-a'])
    expect(capById('funcs')!.buildArgv({ pkg: 'com.android.deskclock', spec: 'x.spec', snapshot: true }))
      .toEqual(['funcs', '-P', 'com.android.deskclock', '-F', '/data/local/tmp/specs/x.spec', '--snapshot'])
    expect(capById('funcs')!.buildArgv({ pkg: 'com.android.deskclock', spec: 'x.spec' }))
      .toEqual(['funcs', '-P', 'com.android.deskclock', '-F', '/data/local/tmp/specs/x.spec'])
  })
})

import { composeRunArg, outJsonlPath, DEVICE_BIN, STOP_ARG, commonArgv } from '../src/shared/tracer-caps'

describe('composeRunArg', () => {
  const syscalls = capById('syscalls')!
  const mod = capById('mod')!

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
    const arg = composeRunArg({ cap: mod, vals: { analyzer: 'getprop', pkg: 'com.android.deskclock' }, timeoutSecs: 10 })
    expect(arg).toBe("su -c 'timeout -s INT -k 3 10 /data/local/tmp/ares mod getprop -P com.android.deskclock'")
  })

  it('omits the timeout wrapper when timeoutSecs is unset (run until Stop)', () => {
    const arg = composeRunArg({ cap: mod, vals: { analyzer: 'getprop', pkg: 'com.android.deskclock' } })
    expect(arg).toBe("su -c '/data/local/tmp/ares mod getprop -P com.android.deskclock'")
  })

  it('exposes the fixed binary path and stop command', () => {
    expect(DEVICE_BIN).toBe('/data/local/tmp/ares')
    expect(STOP_ARG).toBe("su -c 'pkill -INT -f /data/local/tmp/ares'")
    expect(outJsonlPath('X')).toBe('/data/local/tmp/ares-X.jsonl')
  })

  it('splices -b/-Q/-v before -o for a common cap', () => {
    const arg = composeRunArg({
      cap: syscalls, vals: { pkg: 'com.android.deskclock', lib: 'libc.so', bufmb: '8', verbose: true },
      timeoutSecs: 20, jsonlPath: outJsonlPath('20260712T101500'),
    })
    expect(arg).toBe(
      "su -c 'timeout -s INT -k 3 20 /data/local/tmp/ares syscalls -P com.android.deskclock " +
      "-l libc.so -b 8 -v -o /data/local/tmp/ares-20260712T101500.jsonl'")
  })

  it('never emits tuning flags for a non-common cap even if values are present', () => {
    const arg = composeRunArg({ cap: mod, vals: { analyzer: 'getprop', pkg: 'com.android.deskclock', bufmb: '8', verbose: true } })
    expect(arg).toBe("su -c '/data/local/tmp/ares mod getprop -P com.android.deskclock'")
  })

  it('places --snapshot before the internally-managed -o', () => {
    const arg = composeRunArg({
      cap: syscalls, vals: { pkg: 'com.android.deskclock', lib: 'libc.so', snapshot: true },
      timeoutSecs: 20, jsonlPath: outJsonlPath('20260713T101500'),
    })
    expect(arg).toBe(
      "su -c 'timeout -s INT -k 3 20 /data/local/tmp/ares syscalls -P com.android.deskclock " +
      "-l libc.so --snapshot -o /data/local/tmp/ares-20260713T101500.jsonl'")
  })
})

describe('commonArgv', () => {
  it('emits nothing for blank or default values', () => {
    expect(commonArgv({})).toEqual([])
    expect(commonArgv({ bufmb: '4', queuemb: '256' })).toEqual([])
  })

  it('emits -b/-Q only when diverging from the ares default', () => {
    expect(commonArgv({ bufmb: '8' })).toEqual(['-b', '8'])
    expect(commonArgv({ queuemb: '512' })).toEqual(['-Q', '512'])
    expect(commonArgv({ bufmb: '8', queuemb: '512', verbose: true }))
      .toEqual(['-b', '8', '-Q', '512', '-v'])
  })

  it('emits -v when verbose is checked', () => {
    expect(commonArgv({ verbose: true })).toEqual(['-v'])
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
  it('validates int inputs as whole numbers >= min', () => {
    const sys = capById('syscalls')!
    const base = { pkg: 'com.android.deskclock', all: true }
    expect(fieldErrors(sys, { ...base }).fields.bufmb).toBeUndefined()        // blank ok
    expect(fieldErrors(sys, { ...base, bufmb: '4' }).fields.bufmb).toBeUndefined()
    expect(fieldErrors(sys, { ...base, bufmb: '0' }).fields.bufmb).toBe('must be a whole number >= 1')
    expect(fieldErrors(sys, { ...base, bufmb: '-1' }).fields.bufmb).toBe('must be a whole number >= 1')
    expect(fieldErrors(sys, { ...base, bufmb: '3.5' }).fields.bufmb).toBe('must be a whole number >= 1')
    expect(fieldErrors(sys, { ...base, bufmb: 'abc' }).fields.bufmb).toBe('must be a whole number >= 1')
  })
})

describe('capNeedsSpec', () => {
  it('is true for the spec engines', () => {
    for (const id of ['funcs', 'correlate', 'trace']) {
      expect(capNeedsSpec(capById(id)!)).toBe(true)
    }
  })
  it('is false for the non-spec engines', () => {
    for (const id of ['syscalls', 'mod']) {
      expect(capNeedsSpec(capById(id)!)).toBe(false)
    }
  })
})

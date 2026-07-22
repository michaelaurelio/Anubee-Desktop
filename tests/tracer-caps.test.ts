import { describe, it, expect } from 'vitest'
import {
  CAPABILITIES, capById, validateInputs, fieldErrors, capNeedsSpec,
  libList, LIB_SELECTOR_CAP,
} from '../src/shared/tracer-caps'

describe('tracer-caps registry', () => {
  it('exposes only the two engines the app can ingest', () => {
    expect(CAPABILITIES.map(c => c.id).sort()).toEqual(['funcs', 'syscalls'])
    expect(capById('syscalls')!.outputKind).toBe('jsonl')
    expect(capById('funcs')!.outputKind).toBe('jsonl')
  })

  it('no longer exposes correlate, trace, mod, lib or dump', () => {
    for (const id of ['correlate', 'trace', 'mod', 'lib', 'dump']) {
      expect(capById(id), `${id} must be gone`).toBeUndefined()
    }
  })

  // Anubee removed -a (commit ad14f98): absence of -l IS capture-all.
  it('builds bare capture-all syscalls argv with no -a and no -l', () => {
    expect(capById('syscalls')!.buildArgv({ pkg: 'dev.anubee.detector' }))
      .toEqual(['syscalls', '-P', 'dev.anubee.detector'])
  })

  it('emits one -l pair per selector, in order', () => {
    expect(capById('syscalls')!.buildArgv({
      pkg: 'dev.anubee.detector', libs: 'libsentinel.so\ne_*',
    })).toEqual([
      'syscalls', '-P', 'dev.anubee.detector',
      '-l', 'libsentinel.so', '-l', 'e_*',
    ])
  })

  it('accepts an empty filter list as capture-all', () => {
    expect(validateInputs(capById('syscalls')!, { pkg: 'dev.anubee.detector' })).toEqual([])
  })

  it('accepts glob metacharacters in a selector but not shell metacharacters', () => {
    const cap = capById('syscalls')!
    expect(fieldErrors(cap, { pkg: 'p', libs: 'e_*\nlib?.so\nlib[0-9].so' }).fields.libs).toBeUndefined()
    expect(fieldErrors(cap, { pkg: 'p', libs: 'e_$(id)' }).fields.libs).toBeTruthy()
    expect(fieldErrors(cap, { pkg: 'p', libs: 'has space' }).fields.libs).toBeTruthy()
  })

  it('rejects more selectors than the device accepts', () => {
    const many = Array.from({ length: LIB_SELECTOR_CAP + 1 }, (_, i) => `lib${i}.so`).join('\n')
    expect(fieldErrors(capById('syscalls')!, { pkg: 'p', libs: many }).fields.libs)
      .toContain(String(LIB_SELECTOR_CAP))
  })

  it('libList trims, drops empties, and preserves order', () => {
    expect(libList(' a \n\n b \n')).toEqual(['a', 'b'])
    expect(libList(undefined)).toEqual([])
    expect(libList(true)).toEqual([])
  })

  it('builds funcs argv with a spec path', () => {
    expect(capById('funcs')!.buildArgv({ pkg: 'dev.anubee.detector', spec: 'common-file.spec' }))
      .toEqual(['funcs', '-P', 'dev.anubee.detector', '-F', '/data/local/tmp/specs/common-file.spec'])
  })

  it('only funcs needs a spec', () => {
    expect(capNeedsSpec(capById('funcs')!)).toBe(true)
    expect(capNeedsSpec(capById('syscalls')!)).toBe(false)
  })

  it('rejects missing required inputs', () => {
    expect(validateInputs(capById('syscalls')!, {})).toContain('package is required')
  })

  it('accepts a valid input set', () => {
    expect(validateInputs(capById('syscalls')!, { pkg: 'com.android.deskclock', libs: 'libc.so' })).toEqual([])
  })

  it('rejects a token carrying a shell metacharacter or space', () => {
    // A single quote would close the su -c '...' body; a space would split the arg.
    expect(validateInputs(capById('syscalls')!, { pkg: 'com.app', libs: "libc.so'; rm -rf /" }))
      .toEqual(['library filters selector "libc.so\'; rm -rf /" has unsupported characters ' +
        '(allowed: letters, digits, . _ - / : , + and the globs * ? [ ])'])
    expect(validateInputs(capById('syscalls')!, { pkg: 'com.app', libs: 'lib c.so' }))
      .toContain('library filters selector "lib c.so" has unsupported characters ' +
        '(allowed: letters, digits, . _ - / : , + and the globs * ? [ ])')
  })

  it('accepts the real token punctuation (dots, comma-csv, slash, hyphen)', () => {
    expect(validateInputs(capById('syscalls')!, { pkg: 'com.android.deskclock', syscalls: 'openat,read' }))
      .toEqual([])
    expect(validateInputs(capById('funcs')!, { pkg: 'com.app', spec: 'common-file.spec' })).toEqual([])
  })

  it('adds the common tuning inputs to both surviving engines', () => {
    const tuningKeys = ['bufmb', 'queuemb', 'verbose']
    for (const id of ['syscalls', 'funcs']) {
      const keys = capById(id)!.inputs.map(i => i.key)
      expect(keys).toEqual(expect.arrayContaining(tuningKeys))
      expect(capById(id)!.common).toBe(true)
    }
  })

  it('marks the tuning inputs advanced with anubee defaults', () => {
    const buf = capById('syscalls')!.inputs.find(i => i.key === 'bufmb')!
    const q = capById('syscalls')!.inputs.find(i => i.key === 'queuemb')!
    const v = capById('syscalls')!.inputs.find(i => i.key === 'verbose')!
    expect(buf).toMatchObject({ kind: 'int', default: 4, min: 1, advanced: true })
    expect(q).toMatchObject({ kind: 'int', default: 256, min: 1, advanced: true })
    expect(v).toMatchObject({ kind: 'bool', advanced: true })
  })

  it('adds the --snapshot input to syscalls and funcs', () => {
    for (const id of ['syscalls', 'funcs']) {
      expect(capById(id)!.inputs.map(i => i.key)).toContain('snapshot')
    }
    const snap = capById('syscalls')!.inputs.find(i => i.key === 'snapshot')!
    expect(snap).toMatchObject({ kind: 'bool', advanced: true })
  })

  it('emits --snapshot in syscalls/funcs argv only when checked', () => {
    expect(capById('syscalls')!.buildArgv({ pkg: 'com.android.deskclock', snapshot: true }))
      .toEqual(['syscalls', '-P', 'com.android.deskclock', '--snapshot'])
    expect(capById('syscalls')!.buildArgv({ pkg: 'com.android.deskclock' }))
      .toEqual(['syscalls', '-P', 'com.android.deskclock'])
    expect(capById('funcs')!.buildArgv({ pkg: 'com.android.deskclock', spec: 'x.spec', snapshot: true }))
      .toEqual(['funcs', '-P', 'com.android.deskclock', '-F', '/data/local/tmp/specs/x.spec', '--snapshot'])
    expect(capById('funcs')!.buildArgv({ pkg: 'com.android.deskclock', spec: 'x.spec' }))
      .toEqual(['funcs', '-P', 'com.android.deskclock', '-F', '/data/local/tmp/specs/x.spec'])
  })
})

import { composeRunArg, needsDeviceQuote, outJsonlPath, DEVICE_BIN, STOP_ARG, commonArgv, ereEscape, stopArgLive, stopArgWatch, isSafePattern, isSafeToken, type Capability } from '../src/shared/tracer-caps'

describe('composeRunArg', () => {
  const syscalls = capById('syscalls')!
  // mod (outputKind 'stdout') was removed as an ingestible engine, so no
  // CAPABILITIES entry has outputKind 'stdout' anymore. composeRunArg's -o
  // omission is still real, general behaviour - exercise it with a stub cap.
  const stdoutCap: Capability = {
    id: 'stdout-stub', label: 'stdout stub', engine: 'stub', outputKind: 'stdout',
    inputs: [{ key: 'pkg', label: 'package', kind: 'package', required: true }],
    buildArgv: (v) => ['stub', '-P', typeof v.pkg === 'string' ? v.pkg : ''],
  }

  it('wraps a jsonl run in su -c + timeout and appends -o', () => {
    const arg = composeRunArg({
      cap: syscalls, vals: { pkg: 'com.android.deskclock', libs: 'libc.so' },
      timeoutSecs: 20, jsonlPath: outJsonlPath('20260707T101500'),
    })
    expect(arg).toBe(
      "su -c 'timeout -s INT -k 3 20 /data/local/tmp/anubee syscalls -P com.android.deskclock " +
      "-l libc.so -o /data/local/tmp/anubee-20260707T101500.jsonl'")
  })

  it('does not append -o for a stdout capability', () => {
    const arg = composeRunArg({ cap: stdoutCap, vals: { pkg: 'com.android.deskclock' }, timeoutSecs: 10 })
    expect(arg).toBe("su -c 'timeout -s INT -k 3 10 /data/local/tmp/anubee stub -P com.android.deskclock'")
  })

  it('omits the timeout wrapper when timeoutSecs is unset (run until Stop)', () => {
    const arg = composeRunArg({ cap: stdoutCap, vals: { pkg: 'com.android.deskclock' } })
    expect(arg).toBe("su -c '/data/local/tmp/anubee stub -P com.android.deskclock'")
  })

  it('exposes the fixed binary path and stop command', () => {
    expect(DEVICE_BIN).toBe('/data/local/tmp/anubee')
    expect(STOP_ARG).toBe("su -c 'pkill -INT -f /data/local/tmp/anubee'")
    expect(outJsonlPath('X')).toBe('/data/local/tmp/anubee-X.jsonl')
  })

  it('stopArgLive targets only the lib stream, anchored and ERE-escaped', () => {
    const a = stopArgLive('dev.anubee.detector')
    // Anchored on the binary path so it cannot match its own su/sh parent,
    // whose cmdline contains the pattern but does not start with the binary.
    expect(a).toContain('pkill -INT -f')
    expect(a).toContain('^/data/local/tmp/anubee lib -P dev\\.anubee\\.detector$')
    // A dot must be escaped: unescaped it would also match devXanubeeYdetector.
    expect(a).not.toContain('dev.anubee.detector$')
  })

  it('stopArgWatch targets only the on-map watcher for one pid', () => {
    const a = stopArgWatch(25659)
    expect(a).toContain('^/data/local/tmp/anubee dump -p 25659 --on-map')
    // Stops before any -l glob, so the glob never round-trips through ERE.
    expect(a).not.toContain('-l')
  })

  it('neither anchored stop pattern matches its own wrapper shell', () => {
    // Measured on device (dev.anubee.detector): `su -c '<cmd>'` does not strip the
    // quotes before running <cmd> - it re-invokes it through a fresh shell, so
    // the wrapper ps actually reports is `/system/bin/sh -c su -c '<cmd>'`, quotes
    // intact:
    //   24011 [/system/bin/sh -c su -c '/data/local/tmp/anubee lib -P dev.anubee.detector']
    //   24015 [/data/local/tmp/anubee lib -P dev.anubee.detector]
    // That wrapper never starts with the binary path, so ^ excludes it from both
    // patterns. It also never ends right after the command (it ends with the
    // trailing quote), so stopArgLive's trailing $ excludes it too - on this
    // measured shape $ alone would already suffice for stopArgLive; ^ is
    // belt-and-braces there.
    //
    // stopArgWatch has no trailing $ (it deliberately stops before the -l glob),
    // so it has only one line of defence. The unquoted `su -c <cmd>` shape below
    // (no surrounding quotes at all, e.g. what a shell that did not re-wrap via
    // sh -c would produce) still carries the anchored command as a literal
    // substring: stripping ^ from stopArgWatch turns its pattern into a bare
    // substring search that matches both wrapper shapes below - ^ is the sole
    // thing keeping the watcher off its own launcher.
    const liveWrapper = "/system/bin/sh -c su -c '/data/local/tmp/anubee lib -P dev.anubee.detector'"
    const watchWrapper = "/system/bin/sh -c su -c '/data/local/tmp/anubee dump -p 1 --on-map -l libexample*'"
    const watchWrapperUnquoted = 'su -c /data/local/tmp/anubee dump -p 1 --on-map -l libexample*'
    const cases: Array<[string, string]> = [
      [stopArgLive('dev.anubee.detector'), liveWrapper],
      [stopArgWatch(1), watchWrapper],
      [stopArgWatch(1), watchWrapperUnquoted],
    ]
    for (const [a, wrapper] of cases) {
      const re = a.match(/-f "(.+)"/)?.[1]
      expect(re).toBeDefined()
      expect(new RegExp(re!).test(wrapper)).toBe(false)
    }
  })

  it('isSafePattern accepts a glob but still rejects shell-dangerous chars', () => {
    expect(isSafePattern('lib<example>.so'.replace('<example>', 'example'))).toBe(true) // libexample.so
    expect(isSafePattern('libexample*')).toBe(true)
    expect(isSafePattern('blob_[0-9]*')).toBe(true)
    expect(isSafePattern('lib?.so')).toBe(true)
    expect(isSafePattern("lib'; rm -rf /")).toBe(false)  // quote + space
    expect(isSafePattern('lib$(x)')).toBe(false)          // $ (
    expect(isSafePattern('lib`x`')).toBe(false)           // backtick
  })

  it('isSafePattern stays a superset of isSafeToken', () => {
    // SAFE_PATTERN hand-copies SAFE_TOKEN's char class and adds the glob
    // metacharacters. Nothing in the types ties them together, so this pins the
    // relationship: tighten or widen SAFE_TOKEN without SAFE_PATTERN and this
    // fails instead of the two silently diverging.
    const samples = ['A', 'z', 'Z', 'a', '0', '9', '.', '_', ':', '/', ',', '+', '-',
                     'dev.anubee.detector', 'libsentinel.so', '/data/local/tmp/anubee']
    // Guard against a vacuous pass: every sample must really be a safe token.
    expect(samples.every(s => isSafeToken(s))).toBe(true)
    for (const s of samples) expect(isSafePattern(s)).toBe(true)
  })

  it('splices -b/-Q/-v before -o for a common cap', () => {
    const arg = composeRunArg({
      cap: syscalls, vals: { pkg: 'com.android.deskclock', libs: 'libc.so', bufmb: '8', verbose: true },
      timeoutSecs: 20, jsonlPath: outJsonlPath('20260712T101500'),
    })
    expect(arg).toBe(
      "su -c 'timeout -s INT -k 3 20 /data/local/tmp/anubee syscalls -P com.android.deskclock " +
      "-l libc.so -b 8 -v -o /data/local/tmp/anubee-20260712T101500.jsonl'")
  })

  it('never emits tuning flags for a non-common cap even if values are present', () => {
    const arg = composeRunArg({ cap: stdoutCap, vals: { pkg: 'com.android.deskclock', bufmb: '8', verbose: true } })
    expect(arg).toBe("su -c '/data/local/tmp/anubee stub -P com.android.deskclock'")
  })

  it('places --snapshot before the internally-managed -o', () => {
    const arg = composeRunArg({
      cap: syscalls, vals: { pkg: 'com.android.deskclock', libs: 'libc.so', snapshot: true },
      timeoutSecs: 20, jsonlPath: outJsonlPath('20260713T101500'),
    })
    expect(arg).toBe(
      "su -c 'timeout -s INT -k 3 20 /data/local/tmp/anubee syscalls -P com.android.deskclock " +
      "-l libc.so --snapshot -o /data/local/tmp/anubee-20260713T101500.jsonl'")
  })
})

describe('commonArgv', () => {
  it('emits nothing for blank or default values', () => {
    expect(commonArgv({})).toEqual([])
    expect(commonArgv({ bufmb: '4', queuemb: '256' })).toEqual([])
  })

  it('emits -b/-Q only when diverging from the anubee default', () => {
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
    const { fields } = fieldErrors(syscalls, {})
    expect(fields.pkg).toBe('is required')
  })
  it('reports an unsupported-character field by key', () => {
    const { fields } = fieldErrors(syscalls, { pkg: 'com bad' })
    expect(fields.pkg).toMatch(/unsupported characters/)
  })
  // syscalls no longer has a validate(): Anubee removed -a, so absence of
  // every -l selector is a legal capture-all run, not a cross-field error.
  it('has no cross-field errors for syscalls (no filter required)', () => {
    const { fields, form } = fieldErrors(syscalls, { pkg: 'com.x' })
    expect(fields.pkg).toBeUndefined()
    expect(form).toEqual([])
  })
  it('validates int inputs as whole numbers >= min', () => {
    const sys = capById('syscalls')!
    const base = { pkg: 'com.android.deskclock' }
    expect(fieldErrors(sys, { ...base }).fields.bufmb).toBeUndefined()        // blank ok
    expect(fieldErrors(sys, { ...base, bufmb: '4' }).fields.bufmb).toBeUndefined()
    expect(fieldErrors(sys, { ...base, bufmb: '0' }).fields.bufmb).toBe('must be a whole number >= 1')
    expect(fieldErrors(sys, { ...base, bufmb: '-1' }).fields.bufmb).toBe('must be a whole number >= 1')
    expect(fieldErrors(sys, { ...base, bufmb: '3.5' }).fields.bufmb).toBe('must be a whole number >= 1')
    expect(fieldErrors(sys, { ...base, bufmb: 'abc' }).fields.bufmb).toBe('must be a whole number >= 1')
  })
})

describe('capNeedsSpec', () => {
  it('is true for the spec engine', () => {
    expect(capNeedsSpec(capById('funcs')!)).toBe(true)
  })
  it('is false for the non-spec engine', () => {
    expect(capNeedsSpec(capById('syscalls')!)).toBe(false)
  })
})

describe('composeRunArg device-shell quoting', () => {
  it('flags only glob-bearing tokens', () => {
    expect(needsDeviceQuote('e_*')).toBe(true)
    expect(needsDeviceQuote('lib?.so')).toBe(true)
    expect(needsDeviceQuote('lib[0-9].so')).toBe(true)
    expect(needsDeviceQuote('libsentinel.so')).toBe(false)
    expect(needsDeviceQuote('dev.anubee.detector')).toBe(false)
  })

  // su -c '<inner>' runs inner through the device sh; an unquoted e_* would be
  // expanded against the device cwd (and survives literally only by luck).
  it("single-quotes a glob selector inside the su -c body", () => {
    const arg = composeRunArg({
      cap: capById('syscalls')!,
      vals: { pkg: 'dev.anubee.detector', libs: 'e_*' },
      jsonlPath: '/data/local/tmp/x.jsonl',
    })
    expect(arg).toBe(
      "su -c '/data/local/tmp/anubee syscalls -P dev.anubee.detector -l '\\''e_*'\\'' -o /data/local/tmp/x.jsonl'")
  })

  it('leaves plain tokens bare', () => {
    const arg = composeRunArg({
      cap: capById('syscalls')!,
      vals: { pkg: 'dev.anubee.detector', libs: 'libsentinel.so' },
      jsonlPath: '/data/local/tmp/x.jsonl',
    })
    expect(arg).toBe(
      "su -c '/data/local/tmp/anubee syscalls -P dev.anubee.detector -l libsentinel.so -o /data/local/tmp/x.jsonl'")
  })

  it('keeps quoting under a timeout wrapper', () => {
    const arg = composeRunArg({
      cap: capById('syscalls')!,
      vals: { pkg: 'dev.anubee.detector', libs: 'e_*' },
      timeoutSecs: 30,
      jsonlPath: '/data/local/tmp/x.jsonl',
    })
    expect(arg).toContain("timeout -s INT -k 3 30 /data/local/tmp/anubee syscalls")
    expect(arg).toContain("-l '\\''e_*'\\''")
  })
})

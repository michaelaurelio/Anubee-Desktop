import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { capById, composeRunArg, outJsonlPath, type CapValues } from '../src/shared/tracer-caps'

// The argp option tables in the sibling Anubee checkout, plus the shared-flag
// macros (COMMON_ARGP_OPTIONS / TARGET_ARGP_OPTIONS) those tables embed by
// name. Not a build dependency - read only to guard the vendored flag
// surface. Absent -> skip.
const SYSCALLS_C = resolve(__dirname, '../../Anubee/src/syscalls/syscalls.c')
const FUNCS_C = resolve(__dirname, '../../Anubee/src/funcs/funcs.c')
const ENGINE_ARGS_H = resolve(__dirname, '../../Anubee/src/common/engine_args.h')
const present = existsSync(SYSCALLS_C) && existsSync(FUNCS_C) && existsSync(ENGINE_ARGS_H)

// Extracts every "{ "long", 'x' | <digit/macro key>, ... }" flag entry out of
// a C source slice shaped like an argp_option table. Shared by argpFlags (the
// per-engine tables) and macroFlags (the two engine_args.h macros those
// tables embed) so the two never drift from each other's idea of a flag
// entry.
function flagsFromTable(table: string): Set<string> {
  const flags = new Set<string>()
  // { "long", 'x', ... }  ->  --long and -x
  for (const m of table.matchAll(/\{\s*"([a-z-]+)"\s*,\s*'(.)'/g)) {
    flags.add(`--${m[1]}`); flags.add(`-${m[2]}`)
  }
  // { "long", <numeric key or MACRO_KEY>, ... }  ->  --long only (no short form)
  for (const m of table.matchAll(/\{\s*"([a-z-]+)"\s*,\s*(?:\d+|[A-Z][A-Z0-9_]*)\s*,/g)) {
    flags.add(`--${m[1]}`)
  }
  return flags
}

// Parses the real macro body out of engine_args.h (COMMON_ARGP_OPTIONS /
// TARGET_ARGP_OPTIONS) instead of hardcoding what it is believed to contain.
// A hardcoded list cannot notice an upstream removal from either macro (e.g.
// -Q) - exactly the class of regression this suite exists to catch, and
// exactly what happened with -a. Matches a #define's continuation lines
// (each ending in a trailing backslash) through to its first non-continued
// line - the shape every macro in this header uses.
function macroFlags(name: 'COMMON_ARGP_OPTIONS' | 'TARGET_ARGP_OPTIONS'): Set<string> {
  const src = readFileSync(ENGINE_ARGS_H, 'utf-8')
  const m = src.match(new RegExp(`#define ${name}[^\\n]*\\n((?:.*\\\\\\n)*.+)`))
  expect(m, `${name} not found in ${ENGINE_ARGS_H}`).not.toBeNull()
  return flagsFromTable(m![1])
}

// Every short flag and long name in an engine's argp_option table, plus the
// COMMON_ARGP_OPTIONS / TARGET_ARGP_OPTIONS macros it embeds - both now
// parsed from the real sources, not hardcoded.
function argpFlags(file: string): Set<string> {
  const src = readFileSync(file, 'utf-8')
  const start = src.indexOf('argp_option')
  expect(start, `${file} has no argp_option table`).toBeGreaterThanOrEqual(0)
  const table = src.slice(start, src.indexOf('{ 0 }', start))
  const flags = flagsFromTable(table)
  if (table.includes('COMMON_ARGP_OPTIONS')) for (const f of macroFlags('COMMON_ARGP_OPTIONS')) flags.add(f)
  if (table.includes('TARGET_ARGP_OPTIONS')) for (const f of macroFlags('TARGET_ARGP_OPTIONS')) flags.add(f)
  return flags
}

// Every flag the desktop can actually put on the wire for a capability, with
// all optional inputs on. Goes through composeRunArg (not buildArgv alone) so
// commonArgv's -b/-Q/-v and the -o composeRunArg appends are covered too -
// buildArgv alone misses exactly the flags this guard most needs to catch,
// since they reach the device the same as any other. No timeoutSecs, so the
// `timeout -s INT -k 3 N` wrapper (and its own unrelated -s/-k) never appears.
function emittedFlags(id: string, vals: CapValues): string[] {
  const cap = capById(id)!
  const arg = composeRunArg({ cap, vals, jsonlPath: outJsonlPath('X') })
  const inner = arg.replace(/^su -c '/, '').replace(/'$/, '')
  return inner.split(' ').filter(t => t.startsWith('-'))
}

describe('anubee flag drift: desktop argv vs Anubee argp tables', () => {
  it.skipIf(!present)('every syscalls flag the desktop emits still exists', () => {
    const known = argpFlags(SYSCALLS_C)
    const emitted = emittedFlags('syscalls', {
      pkg: 'dev.anubee.detector', libs: 'libsentinel.so', syscalls: 'openat', snapshot: true,
      bufmb: '8', queuemb: '512', verbose: true,
    })
    expect(emitted.length).toBeGreaterThan(0)
    for (const f of emitted) expect(known, `anubee syscalls no longer accepts "${f}"`).toContain(f)
  })

  it.skipIf(!present)('every funcs flag the desktop emits still exists', () => {
    const known = argpFlags(FUNCS_C)
    const emitted = emittedFlags('funcs', {
      pkg: 'dev.anubee.detector', spec: 'common-file.spec', snapshot: true,
      bufmb: '8', queuemb: '512', verbose: true,
    })
    expect(emitted.length).toBeGreaterThan(0)
    for (const f of emitted) expect(known, `anubee funcs no longer accepts "${f}"`).toContain(f)
  })

  // The specific regression this suite exists for.
  it.skipIf(!present)('confirms -a is gone from syscalls and the desktop never emits it', () => {
    expect(argpFlags(SYSCALLS_C)).not.toContain('-a')
    expect(emittedFlags('syscalls', { pkg: 'dev.anubee.detector' })).not.toContain('-a')
  })

  // Runs without the sibling checkout, so CI still asserts something.
  it('the desktop emits no flag outside its own vendored allowlist', () => {
    const allow = new Set(['-P', '-l', '-s', '-F', '-o', '-b', '-Q', '-v', '--snapshot'])
    const all = [
      ...emittedFlags('syscalls', { pkg: 'p', libs: 'a', syscalls: 'openat', snapshot: true, bufmb: '8', verbose: true }),
      ...emittedFlags('funcs', { pkg: 'p', spec: 'x.spec', snapshot: true, queuemb: '512' }),
    ]
    expect(all.length).toBeGreaterThan(0)
    for (const f of all) expect(allow, `unexpected flag "${f}"`).toContain(f)
  })
})

if (!present) {
  console.warn(`[flag-drift] ../Anubee not found at ${SYSCALLS_C} - drift checks skipped.`)
}

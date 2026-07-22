import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { capById, type CapValues } from '../src/shared/tracer-caps'

// The argp option tables in the sibling Anubee checkout. Not a build
// dependency - read only to guard the vendored flag surface. Absent -> skip.
const SYSCALLS_C = resolve(__dirname, '../../Anubee/src/syscalls/syscalls.c')
const FUNCS_C = resolve(__dirname, '../../Anubee/src/funcs/funcs.c')
const present = existsSync(SYSCALLS_C) && existsSync(FUNCS_C)

// Every short flag and long name in an engine's argp_option table, plus the
// COMMON_ARGP_OPTIONS / TARGET_ARGP_OPTIONS macros it embeds.
function argpFlags(file: string): Set<string> {
  const src = readFileSync(file, 'utf-8')
  const start = src.indexOf('argp_option')
  expect(start, `${file} has no argp_option table`).toBeGreaterThanOrEqual(0)
  const table = src.slice(start, src.indexOf('{ 0 }', start))
  const flags = new Set<string>()
  // { "long", 'x', ... }  ->  --long and -x
  for (const m of table.matchAll(/\{\s*"([a-z-]+)"\s*,\s*'(.)'/g)) {
    flags.add(`--${m[1]}`); flags.add(`-${m[2]}`)
  }
  // { "long", <numeric key>, ... }  ->  --long only
  for (const m of table.matchAll(/\{\s*"([a-z-]+)"\s*,\s*\d+\s*,/g)) flags.add(`--${m[1]}`)
  // Flags the table pulls in by macro rather than spelling out.
  if (table.includes('COMMON_ARGP_OPTIONS')) for (const f of ['-o', '-v', '-q', '-b', '-Q']) flags.add(f)
  if (table.includes('TARGET_ARGP_OPTIONS')) for (const f of ['-p', '--siblings', '--no-follow-fork']) flags.add(f)
  return flags
}

// Every flag the desktop can emit for a capability, with all optional inputs on.
function emittedFlags(id: string, vals: CapValues): string[] {
  return capById(id)!.buildArgv(vals).filter(t => t.startsWith('-'))
}

describe('anubee flag drift: desktop argv vs Anubee argp tables', () => {
  it.skipIf(!present)('every syscalls flag the desktop emits still exists', () => {
    const known = argpFlags(SYSCALLS_C)
    const emitted = emittedFlags('syscalls', {
      pkg: 'dev.anubee.detector', libs: 'libsentinel.so', syscalls: 'openat', snapshot: true,
    })
    expect(emitted.length).toBeGreaterThan(0)
    for (const f of emitted) expect(known, `anubee syscalls no longer accepts "${f}"`).toContain(f)
  })

  it.skipIf(!present)('every funcs flag the desktop emits still exists', () => {
    const known = argpFlags(FUNCS_C)
    const emitted = emittedFlags('funcs', {
      pkg: 'dev.anubee.detector', spec: 'common-file.spec', snapshot: true,
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
      ...emittedFlags('syscalls', { pkg: 'p', libs: 'a', syscalls: 'openat', snapshot: true }),
      ...emittedFlags('funcs', { pkg: 'p', spec: 'x.spec', snapshot: true }),
    ]
    for (const f of all) expect(allow, `unexpected flag "${f}"`).toContain(f)
  })
})

if (!present) {
  console.warn(`[flag-drift] ../Anubee not found at ${SYSCALLS_C} - drift checks skipped.`)
}

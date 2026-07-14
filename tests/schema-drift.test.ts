import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SYSCALL_KEYS, BACKTRACE_KEYS, FUNCS_KEYS, CFI_STACK_KEYS, CFI_BACKTRACE_KEYS, LIB_KEYS, UNLIB_KEYS, DUMP_KEYS } from '@shared/schema-contract'

// The syscall emitter in the sibling ARES checkout. Not a build dependency -
// only read here to guard the vendored contract. Absent → skip (CI without the
// sibling still passes).
const EMITTER = resolve(__dirname, '../../ARES/src/syscalls/syscalls.c')
const present = existsSync(EMITTER)

// Extract the quoted JSON keys emitted inside the json_emit() function body.
function emittedKeys(): Set<string> {
  const src = readFileSync(EMITTER, 'utf-8')
  const start = src.indexOf('static void json_emit(')
  expect(start).toBeGreaterThanOrEqual(0)
  // Bound to this function: up to the next top-level `static ` definition.
  const rest = src.slice(start + 1)
  const end = rest.indexOf('\nstatic ')
  const body = end >= 0 ? rest.slice(0, end) : rest
  // Keys appear as C string literals: \"key\":
  const keys = new Set<string>()
  for (const m of body.matchAll(/\\"([a-z_]+)\\":/g)) keys.add(m[1])
  return keys
}

describe('schema drift: vendored contract vs ARES emitter', () => {
  it.skipIf(!present)('emits every top-level syscall key in the contract', () => {
    const keys = emittedKeys()
    for (const k of SYSCALL_KEYS) expect(keys, `emitter missing "${k}"`).toContain(k)
  })

  it.skipIf(!present)('emits every backtrace-frame key in the contract', () => {
    const keys = emittedKeys()
    for (const k of BACKTRACE_KEYS) expect(keys, `emitter missing frame key "${k}"`).toContain(k)
  })

  it('contract has no duplicate keys (sanity, runs without ARES)', () => {
    expect(new Set(SYSCALL_KEYS).size).toBe(SYSCALL_KEYS.length)
  })
})

if (!present) {
  // Surfaced in the runner output so a skipped guard is visible, not silent.
  console.warn(`[schema-drift] ../ARES not found at ${EMITTER} - drift checks skipped.`)
}

// The funcs emitter in the sibling ARES checkout. Not a build dependency -
// only read here to guard the vendored contract. Absent → skip (CI without
// the sibling still passes).
const FUNCS_EMITTER = resolve(__dirname, '../../ARES/src/funcs/funcs_emit.c')
const funcsPresent = existsSync(FUNCS_EMITTER)

function funcsEmittedKeys(): Set<string> {
  const src = readFileSync(FUNCS_EMITTER, 'utf-8')
  const keys = new Set<string>()
  for (const m of src.matchAll(/\\"([a-z_]+)\\":/g)) keys.add(m[1])
  return keys
}

describe('schema drift: funcs emitter', () => {
  it.skipIf(!funcsPresent)('emits every funcs key the app consumes', () => {
    const keys = funcsEmittedKeys()
    for (const k of FUNCS_KEYS) expect(keys, `funcs emitter missing "${k}"`).toContain(k)
  })
})

// The cfi_stack emitter lives in ARES's symbolize.c (ares_emit_cfi_stack_json).
const CFI_EMITTER = resolve(__dirname, '../../ARES/src/common/symbolize.c')
const cfiPresent = existsSync(CFI_EMITTER)

function cfiEmittedKeys(): Set<string> {
  const src = readFileSync(CFI_EMITTER, 'utf-8')
  const keys = new Set<string>()
  for (const m of src.matchAll(/\\"([a-z_]+)\\":/g)) keys.add(m[1])
  return keys
}

describe('schema drift: cfi_stack emitter', () => {
  it('contract has no duplicate cfi keys (sanity, runs without ARES)', () => {
    expect(new Set(CFI_STACK_KEYS).size).toBe(CFI_STACK_KEYS.length)
    expect(new Set(CFI_BACKTRACE_KEYS).size).toBe(CFI_BACKTRACE_KEYS.length)
  })

  it.skipIf(!cfiPresent)('emits every cfi_stack + cfi_backtrace key in the contract', () => {
    const keys = cfiEmittedKeys()
    for (const k of CFI_STACK_KEYS) expect(keys, `emitter missing "${k}"`).toContain(k)
    for (const k of CFI_BACKTRACE_KEYS) expect(keys, `emitter missing frame key "${k}"`).toContain(k)
  })
})

const LIB_EMITTER = resolve(__dirname, '../../ARES/src/common/lib_trace.c')
const libPresent = existsSync(LIB_EMITTER)
const DUMP_EMITTER = resolve(__dirname, '../../ARES/src/dump/dump_emit.c')
const dumpPresent = existsSync(DUMP_EMITTER)

function keysIn(path: string): Set<string> {
  const src = readFileSync(path, 'utf-8')
  const keys = new Set<string>()
  for (const m of src.matchAll(/\\"([a-z_]+)\\":/g)) keys.add(m[1])
  return keys
}

describe('schema drift: lib/unlib + dump emitters', () => {
  it('contract has no duplicate keys (sanity, runs without ARES)', () => {
    expect(new Set(LIB_KEYS).size).toBe(LIB_KEYS.length)
    expect(new Set(UNLIB_KEYS).size).toBe(UNLIB_KEYS.length)
    expect(new Set(DUMP_KEYS).size).toBe(DUMP_KEYS.length)
  })
  it.skipIf(!libPresent)('emits every lib/unlib key in the contract', () => {
    const keys = keysIn(LIB_EMITTER)
    for (const k of LIB_KEYS) expect(keys, `lib_trace.c missing "${k}"`).toContain(k)
    for (const k of UNLIB_KEYS) expect(keys, `lib_trace.c missing "${k}"`).toContain(k)
  })
  it.skipIf(!dumpPresent)('emits every dump manifest key in the contract', () => {
    const keys = keysIn(DUMP_EMITTER)
    for (const k of DUMP_KEYS) expect(keys, `dump_emit.c missing "${k}"`).toContain(k)
  })
})

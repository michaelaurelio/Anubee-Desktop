import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SYSCALL_KEYS, BACKTRACE_KEYS } from '@shared/schema-contract'

// The syscall emitter in the sibling ARES checkout. Not a build dependency —
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
  console.warn(`[schema-drift] ../ARES not found at ${EMITTER} — drift checks skipped.`)
}

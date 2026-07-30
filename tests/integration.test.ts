import { describe, it, expect, afterAll, vi } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { GraphStore } from '../src/main/graph-store'
import { parseJsonl, isSyscall } from '@shared/anubee-parse'
import { foldEvents, foldFuncEvents, mergeGraphs } from '@shared/graph-shape'
import { presenceOf } from '../src/shared/diff'
import type { StackRollup } from '../src/shared/flame-shape'
import { compileWhere, matchSequences, resolveRules, BUILTIN_RULES, validateRule } from '../src/shared/rasp-heuristics'
import type { Rule } from '../src/shared/rasp-heuristics'
import type { SyscallEvent, FuncEvent } from '@shared/events'

// oracle.jsonl is the tiny deterministic fixture these exact-value assertions pin
// to. detector_snap.jsonl is a real dev.anubee.detector capture (see REAL_FIXTURE)
// used by the screenshot harness and the real-data smoke below; it is too
// large/nondeterministic to assert exact ids/counts against.
const FIXTURE = resolve(__dirname, 'fixtures/oracle.jsonl')
const REAL_FIXTURE = resolve(__dirname, 'fixtures/detector_snap.jsonl')
// mixed.jsonl carries the same 3 syscall + 1 lib lines as oracle.jsonl verbatim,
// plus one record each from funcs/coverage (and a couple of foreign rows the
// correlate adapter used to read, now retained-but-unfolded - see the mixed-engine
// tests below). EPIC A retains those foreign rows instead of deleting them at
// ingest - this fixture is the regression oracle proving that retention is
// byte-identical-invisible to every syscall-only view (EPIC 0.2/0.3, folded into
// Epic A Phase 1).
const MIXED_FIXTURE = resolve(__dirname, 'fixtures/mixed.jsonl')
const store = new GraphStore()

afterAll(() => store.close())

describe('integration: load the fixture end to end', () => {
  it('ingests syscalls, tolerates the bad line, ignores the non-syscall record', async () => {
    const r = await store.ingest(FIXTURE)
    expect(r.eventCount).toBe(3) // 3 syscalls; lib + bad line excluded
    expect(r.errors).toBe(1) // the deliberately malformed line
  })

  it('reconstructs the root-check bridge and filters to java-bearing events', async () => {
    await store.ingest(FIXTURE)
    const withJava = await store.slice({ hasJavaStack: true })
    expect(withJava.eventCount).toBe(2)
    const ids = withJava.nodes.map(n => n.id)
    expect(ids).toContain('java:com.example.app.RootCheck.run')
    expect(ids).toContain('nat:libexample.so!check_su')
    expect(ids).toContain('sys:openat')
    expect(ids).not.toContain('sys:read')
  })

  it('the DuckDB slice matches the pure-TS foldEvents oracle over the whole run', async () => {
    await store.ingest(FIXTURE)
    const oracle = foldEvents(parseJsonl(readFileSync(FIXTURE, 'utf-8')).events.filter(isSyscall))
    const slice = await store.slice()
    const ids = (xs: { id: string }[]) => xs.map(x => x.id).sort()
    expect(ids(slice.nodes)).toEqual(ids(oracle.nodes))
    expect(ids(slice.edges)).toEqual(ids(oracle.edges))
    expect(slice.eventCount).toBe(oracle.eventCount)
  })

  it('ingests the real capture and the DuckDB slice still matches the foldEvents oracle', async () => {
    // Content-agnostic invariant run over a real dev.anubee.detector capture: the
    // SQL slice and the pure-TS fold must agree on any input, not just the toy one.
    const real = new GraphStore()
    const r = await real.ingest(REAL_FIXTURE)
    expect(r.eventCount).toBeGreaterThan(0)
    expect(r.errors).toBe(0) // a clean tracer file has no malformed lines
    const oracle = foldEvents(parseJsonl(readFileSync(REAL_FIXTURE, 'utf-8')).events.filter(isSyscall))
    const slice = await real.slice()
    const ids = (xs: { id: string }[]) => xs.map(x => x.id).sort()
    expect(ids(slice.nodes)).toEqual(ids(oracle.nodes))
    expect(ids(slice.edges)).toEqual(ids(oracle.edges))
    // The capture carries real RASP bridges, so the has-java_stack slice is non-empty.
    expect((await real.slice({ hasJavaStack: true })).eventCount).toBeGreaterThan(0)
    await real.close()
    // The only test that ingests the 8.5MB real capture (DuckDB read_json plus a
    // full TS fold of every syscall). It is the slowest in the suite by an order
    // of magnitude - ~1.5s idle, but >7s when the machine is loaded, which
    // silently blew vitest's 5s default and made this the suite's one flaky test.
    // Timed out here rather than raising testTimeout globally, which would mask a
    // real hang in the other fast tests.
  }, 30000)

  it('filters by library and by tid', async () => {
    await store.ingest(FIXTURE)
    expect((await store.table({ library: 'libexample' }, { limit: 100, offset: 0 })).map(r => r.id)).toEqual([1, 2])
    expect((await store.table({ tid: 202 }, { limit: 100, offset: 0 })).map(r => r.id)).toEqual([3])
  })
})

function fixture(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'anubee-'))
  const p = join(dir, 'run.jsonl')
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n'))
  return p
}

const evA = { type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 56, syscall: 'openat',
  args: ['0xffffff9c', '0x0'], retval: 7, string_args: { '1': '/system/bin/su' },
  fd_args: {}, decoded_args: {}, java_stack: ['com.example.app.RootCheck.run'],
  backtrace: [{ frame: 0, addr: '0x1', symbol: 'libexample.so!check_su+0x10' }] }

describe('multi-run store', () => {
  it('keeps two runs addressable and returns distinct runIds', async () => {
    const store = new GraphStore()
    const a = await store.ingest(fixture([evA]))
    const b = await store.ingest(fixture([{ ...evA, syscall: 'ptrace', string_args: {} }]))
    expect(a.runId).not.toBe(b.runId)
    expect(store.runs().map(r => r.runId).sort()).toEqual([a.runId, b.runId].sort())

    const rowsA = await store.table({}, { limit: 10, offset: 0 }, a.runId)
    const rowsB = await store.table({}, { limit: 10, offset: 0 }, b.runId)
    expect(rowsA.map(r => r.syscall)).toEqual(['openat'])
    expect(rowsB.map(r => r.syscall)).toEqual(['ptrace'])
    await store.close()
  })

  it('defaults queries to the most recent run', async () => {
    const store = new GraphStore()
    await store.ingest(fixture([evA]))
    await store.ingest(fixture([{ ...evA, syscall: 'ptrace', string_args: {} }]))
    const rows = await store.table({}, { limit: 10, offset: 0 })
    expect(rows.map(r => r.syscall)).toEqual(['ptrace'])
    await store.close()
  })
})

describe('nodeEvents run scoping', () => {
  it('scopes nodeEvents to the requested run even when ids collide across runs', async () => {
    const store = new GraphStore()
    const a = await store.ingest(fixture([{ ...evA, string_args: { '1': '/system/bin/su' }, tid: 101 }]))
    const b = await store.ingest(fixture([{ ...evA, string_args: { '1': '/system/bin/su' }, tid: 999 }]))
    const events = await store.nodeEvents('sys:openat', {}, 500, b.runId)
    expect(events).toHaveLength(1)
    expect(events[0].tid).toBe(999)
    await store.close()
  })
})

describe('heuristic suggestions', () => {
  it('suggests root + debugger + hook tags from a run using the built-in set', async () => {
    const store = new GraphStore()
    await store.ingest(fixture([
      evA, // openat /system/bin/su -> root
      { ...evA, id: 2, syscall: 'ptrace', args: ['0x0'], string_args: {}, backtrace: [] }, // TRACEME -> debugger
      { ...evA, id: 3, syscall: 'openat', string_args: { '1': '/proc/self/maps' },
        backtrace: [{ frame: 0, addr: '0x2', symbol: 'libhook.so!scan_maps+0x4' }] }, // -> hook (distinct target so it doesn't collapse into root's aggregate entry)
      { ...evA, id: 4, syscall: 'openat', string_args: { '1': '/data/app/ok.so' } }, // benign
    ]))
    const s = await store.suggest()
    const cats = s.map(x => x.category).sort()
    expect(cats).toContain('root')
    expect(cats).toContain('debugger')
    expect(cats).toContain('hook')
    expect(s.find(x => x.category === 'root')!.target).toBe('nat:libexample.so!check_su')
    await store.close()
  })

  it('honors an explicit resolved rule set (a disabled built-in stops firing)', async () => {
    const store = new GraphStore()
    await store.ingest(fixture([{ ...evA, syscall: 'ptrace', args: ['0x0'], string_args: {},
      backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] }]))
    const disabled = resolveRules(BUILTIN_RULES, { rules: [], enabledOverrides: { 'dbg-ptrace-traceme': false } }, { rules: [], enabledOverrides: {} })
      .filter(r => r.enabled)
    const s = await store.suggest(undefined, disabled)
    expect(s.some(x => x.category === 'debugger')).toBe(false)
    await store.close()
  })

  it('returns nothing when no rules are enabled', async () => {
    const store = new GraphStore()
    await store.ingest(fixture([evA]))
    expect(await store.suggest(undefined, [])).toEqual([])
    await store.close()
  })

  it('reports one row per category on a multi-behaviour library', async () => {
    const store = new GraphStore()
    const bt = [{ frame: 0, addr: '0x1000', symbol: 'libc.so!openat+0x8' },
                { frame: 1, addr: '0x2100', symbol: 'libsentinel.so!chk+0x100' }]
    await store.ingest(fixture([
      { ...evA, id: 1, syscall: 'openat', string_args: { '1': '/system/xbin/su' }, backtrace: bt },
      { ...evA, id: 2, syscall: 'openat', string_args: { '1': '/proc/self/status' }, backtrace: bt },
      { ...evA, id: 3, syscall: 'openat', string_args: { '1': '/proc/self/maps' }, backtrace: bt },
    ]))
    const s = await store.suggest()
    const forNode = s.filter(x => x.target === 'nat:libsentinel.so!chk')
    expect(forNode.map(x => x.category).sort()).toEqual(['debugger', 'hook', 'root'])
    expect(forNode.every(x => x.offsets.length > 0)).toBe(true)
    await store.close()
  })

  it('yields no suggestion targeting a platform library', async () => {
    const store = new GraphStore()
    // evA's java_stack is cleared here: a platform-only native chain with a java
    // fallback attributes to the java frame by design (see rasp-heuristics'
    // "falls back to the innermost java frame for a pure-java check"); this test
    // isolates the platform-only-stack-with-no-app-owner case, which keeps the
    // detection but names the synthetic target rather than libc or libart
    // (mirrors "does not attribute a platform-only stack to a platform library"
    // in tests/rasp-heuristics.test.ts).
    await store.ingest(fixture([{ ...evA, id: 1, syscall: 'openat',
      string_args: { '1': '/proc/self/maps' }, java_stack: [],
      backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libc.so!openat+0x8' },
                  { frame: 1, addr: '0x2000', symbol: 'libart.so!ReadMaps+0x40' }] }]))
    const s = await store.suggest()
    expect(s.map(x => x.target)).toEqual(['rasp:unattributed:hook'])
    expect(s.some(x => x.target.includes('libc.so') || x.target.includes('libart.so'))).toBe(false)
    await store.close()
  })

  it('flags a maps-then-frida scan as a high-confidence hook check', async () => {
    const store = new GraphStore()
    const bt = [{ frame: 0, addr: '0x1000', symbol: 'libc.so!openat+0x8' },
                { frame: 1, addr: '0x2100', symbol: 'libsentinel.so!scan+0x100' }]
    await store.ingest(fixture([
      { ...evA, id: 1, syscall: 'openat', string_args: { '1': '/proc/self/maps' }, backtrace: bt },
      { ...evA, id: 2, syscall: 'openat', string_args: { '1': '/data/local/tmp/frida-agent-64.so' }, backtrace: bt },
    ]))
    const s = await store.suggest()
    const hook = s.find(x => x.category === 'hook')!
    expect(hook.confidence).toBe(0.95)
    expect(hook.rationale).toContain('frida')
    await store.close()
  })

  it('leaves a lone maps read at low confidence', async () => {
    const store = new GraphStore()
    await store.ingest(fixture([{ ...evA, id: 1, syscall: 'openat',
      string_args: { '1': '/proc/self/maps' },
      backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libc.so!openat+0x8' },
                  { frame: 1, addr: '0x2100', symbol: 'libsentinel.so!scan+0x100' }] }]))
    const s = await store.suggest()
    expect(s.find(x => x.category === 'hook')!.confidence).toBe(0.4)
    await store.close()
  })

  it('suggests nothing on a platform library across the whole fixture run', async () => {
    const store = new GraphStore()
    await store.ingest(REAL_FIXTURE)
    const bad = (await store.suggest()).filter(s => /^nat:(libart|libc|libandroid_runtime|liblog|libbase)\.so/.test(s.target))
    expect(bad).toEqual([])
    await store.close()
  })

  it('a match whose steps straddle a page boundary still completes', async () => {
    // suggestPage: 1 forces every event onto its own page, so this only passes
    // if the SequenceMatcher survives across suggest()'s paging loop instead of
    // being recreated per page.
    const store = new GraphStore({ suggestPage: 1 })
    const bt = [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!scan+0x100' }]
    const straddleRule: Rule = {
      id: 'test-straddle', category: 'hook', confidence: 0.9, rationale: 'straddle test',
      enabled: true, source: 'project', correlate: 'symbol+tid', maxGap: 50, mode: 'ordered', minOccurrences: 1,
      steps: [
        { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '/proc/self/maps$' },
        { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'frida-agent-64\\.so$' },
      ],
    }
    await store.ingest(fixture([
      { ...evA, id: 1, syscall: 'openat', string_args: { '1': '/proc/self/maps' }, backtrace: bt },
      { ...evA, id: 2, syscall: 'openat', string_args: { '1': '/data/local/tmp/frida-agent-64.so' }, backtrace: bt },
    ]))
    const s = await store.suggest(undefined, [straddleRule])
    expect(s).toHaveLength(1)
    await store.close()
  })
})

describe('suggest honours minOccurrences', () => {
  it('suppresses a target below the rule threshold and keeps one at it', async () => {
    const bt = [{ frame: 0, addr: '0x1000', symbol: 'libc.so!__openat+0x8' },
                { frame: 1, addr: '0x2100', symbol: 'libsentinel.so!scan+0x10' }]
    const events = [1, 2, 3].map(id => ({ ...evA, id, syscall: 'openat', string_args: { '1': '/proc/self/task/9/comm' }, backtrace: bt }))
    const r = { id: 'thr', category: 'hook', confidence: 0.7, rationale: 'r', enabled: true, source: 'global',
      minOccurrences: 3, correlate: 'symbol+tid', maxGap: 50, mode: 'ordered',
      steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '/comm$' }] } as any

    const store = new GraphStore()
    await store.ingest(fixture(events))
    expect(await store.suggest(undefined, [r])).toHaveLength(1)
    expect(await store.suggest(undefined, [{ ...r, minOccurrences: 4 }])).toHaveLength(0)
    await store.close()
  })

  it('drops a below-floor target whole, contributing to neither another row\'s occurrences nor its offsets', async () => {
    const btA = [{ frame: 0, addr: '0x1000', symbol: 'libc.so!__openat+0x8' },
                 { frame: 1, addr: '0x2100', symbol: 'libalpha.so!scanA+0x10' }]
    const btB = [{ frame: 0, addr: '0x1000', symbol: 'libc.so!__openat+0x8' },
                 { frame: 1, addr: '0x2100', symbol: 'libbeta.so!scanB+0x10' }]
    const r: Rule = { id: 'thr', category: 'hook', confidence: 0.7, rationale: 'r', enabled: true, source: 'global',
      minOccurrences: 3, correlate: 'symbol+tid', maxGap: 50, mode: 'ordered',
      steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '/comm$' }] }

    const events = [
      // target a: 2 completed hits, below the floor of 3 - must vanish entirely.
      { ...evA, id: 1, syscall: 'openat', string_args: { '1': '/proc/self/task/9/comm' }, backtrace: btA },
      { ...evA, id: 2, syscall: 'openat', string_args: { '1': '/proc/self/task/9/comm' }, backtrace: btA },
      // target b: 3 completed hits, exactly at the floor - must survive intact.
      { ...evA, id: 3, syscall: 'openat', string_args: { '1': '/proc/self/task/9/comm' }, backtrace: btB },
      { ...evA, id: 4, syscall: 'openat', string_args: { '1': '/proc/self/task/9/comm' }, backtrace: btB },
      { ...evA, id: 5, syscall: 'openat', string_args: { '1': '/proc/self/task/9/comm' }, backtrace: btB },
    ]

    const store = new GraphStore()
    await store.ingest(fixture(events))
    const s = await store.suggest(undefined, [r])
    expect(s).toHaveLength(1)
    expect(s[0].target).toBe('nat:libbeta.so!scanB')
    expect(s[0].occurrences).toBe(3)
    expect(s[0].offsets.reduce((n, o) => n + o.occurrences, 0)).toBe(3)
    expect(s.some(x => x.target === 'nat:libalpha.so!scanA')).toBe(false)
    await store.close()
  })

  it('counts completed sequences, not matched steps, for a multi-step rule', async () => {
    const bt = [{ frame: 0, addr: '0x1000', symbol: 'libc.so!__openat+0x8' },
                { frame: 1, addr: '0x2100', symbol: 'libsentinel.so!scan+0x10' }]
    // Ordered 2-step rule, minOccurrences: 2. Three step-0 events each open their
    // own partial on the shared correlation key (an in-flight partial that is
    // waiting on step 1 cannot itself be advanced by another step-0 event); one
    // step-1 event can then advance only the oldest, so exactly one sequence
    // completes even though four events matched some step of the rule. An
    // implementation that counted matched steps instead of completed sequences
    // would see 4 >= 2 and wrongly keep the hit; counting sequences correctly
    // sees 1 < 2 and drops it, so suggest must return nothing.
    const r: Rule = { id: 'seq', category: 'hook', confidence: 0.7, rationale: 'r', enabled: true, source: 'global',
      minOccurrences: 2, correlate: 'symbol+tid', maxGap: 50, mode: 'ordered',
      steps: [
        { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '/a$' },
        { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '/b$' },
      ] }

    const events = [
      { ...evA, id: 1, syscall: 'openat', string_args: { '1': '/proc/self/a' }, backtrace: bt },
      { ...evA, id: 2, syscall: 'openat', string_args: { '1': '/proc/self/a' }, backtrace: bt },
      { ...evA, id: 3, syscall: 'openat', string_args: { '1': '/proc/self/a' }, backtrace: bt },
      { ...evA, id: 4, syscall: 'openat', string_args: { '1': '/proc/self/b' }, backtrace: bt },
    ]

    const store = new GraphStore()
    await store.ingest(fixture(events))
    expect(await store.suggest(undefined, [r])).toHaveLength(0)
    await store.close()
  })
})

describe('compiler lockstep (real DuckDB admits exactly what matchSequences scores)', () => {
  // Synthetic events modeled on the real record shapes, one per built-in signal.
  const events = [
    { ...evA, id: 1, syscall: 'ptrace', args: ['0x10'], string_args: {},
      backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] },
    { ...evA, id: 2, syscall: 'ptrace', args: ['0x0'], string_args: {},
      backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] },
    { ...evA, id: 3, syscall: 'openat', string_args: { '1': '/proc/self/status' } },
    { ...evA, id: 4, syscall: 'read', string_args: {}, fd_args: { '0': 'fd=6 </proc/self/status>' },
      backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] },
    { ...evA, id: 5, syscall: 'openat', string_args: { '1': '/proc/self/maps' } },
    { ...evA, id: 6, syscall: 'connect', string_args: {}, sock_addr: 'unix:@/frida-zymbiote-abc',
      backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] },
    { ...evA, id: 7, syscall: 'access', string_args: { '1': '/system/xbin/busybox' } },
    { ...evA, id: 8, syscall: 'openat', string_args: { '1': '/sys/fs/selinux/enforce' } },
    { ...evA, id: 9, syscall: 'prctl', args: ['0xdeadbeef'], string_args: {},
      backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] },
    { ...evA, id: 10, syscall: 'openat', string_args: { '1': '/data/app/benign.so' } }, // matches nothing
    { ...evA, id: 11, syscall: 'read', string_args: {}, fd_args: { '0': 'fd=122' },
      backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] }, // unresolved: matches nothing
    { ...evA, id: 12, syscall: 'openat', string_args: { '1': '/data/local/tmp/frida-agent-64.so' } },
    { ...evA, id: 13, syscall: 'process_vm_readv', string_args: {},
      backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] },
    { ...evA, id: 14, syscall: 'prctl', args: ['0x3'], string_args: {}, decoded_args: { '0': 'PR_GET_DUMPABLE' },
      backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] },
    { ...evA, id: 15, syscall: 'ptrace', args: ['0x7'], string_args: {},
      backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] },
    { ...evA, id: 16, syscall: 'bind', string_args: {}, sock_addr: '[::ffff:127.0.0.1]:27042', retval: -98,
      backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] },
    { ...evA, id: 17, syscall: 'faccessat', string_args: { '1': '/system/xbin/su' }, retval: 0 },
    { ...evA, id: 18, syscall: 'faccessat', string_args: { '1': '/system/xbin' }, retval: 0 },
    { ...evA, id: 19, syscall: 'openat', string_args: { '1': '/proc/8185/smaps' } },
    { ...evA, id: 20, syscall: 'openat', string_args: { '1': '/dev/goldfish_sync' } },
  ]

  it('for every built-in rule step, DuckDB WHERE-admission matches the JS predicate', async () => {
    const store = new GraphStore()
    const { runId } = await store.ingest(fixture(events))
    for (const rule of BUILTIN_RULES) {
      for (const [i, step] of rule.steps.entries()) {
        const probe = { ...rule, id: `${rule.id}#${i}`, steps: [step] }
        const where = compileWhere([probe])
        const admitted = new Set(
          (await store.raw(`SELECT id FROM ev WHERE run_id = ${runId} AND (${where})`)).map(r => Number(r.id)),
        )
        for (const e of events) {
          const jsMatches = matchSequences([probe], [e as any]).hits.length > 0
          expect(admitted.has(e.id), `${probe.id} vs event ${e.id}: SQL=${admitted.has(e.id)} JS=${jsMatches}`).toBe(jsMatches)
        }
      }
    }
    await store.close()
  })
})

describe('suggest fail-safe', () => {
  it('returns [] (not throw) when a rule compiles to SQL DuckDB rejects', async () => {
    const store = new GraphStore()
    await store.ingest(fixture([evA]))
    // A rule that bypassed validation with an RE2-incompatible regex -> DuckDB rejects the WHERE.
    const badRule = { id: 'bad', category: 'custom', confidence: 0.5, rationale: 'x', enabled: true, source: 'global',
      steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'foo(?=bar)' }] } as any
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await store.suggest(undefined, [badRule])
    expect(out).toEqual([])
    spy.mockRestore()
    await store.close()
  })
})

describe('decoded_args field integration', () => {
  it('DuckDB WHERE clause for decoded_args path_matches agrees with JS matcher', async () => {
    const store = new GraphStore()
    // Test events with decoded_args field populated
    const events = [
      { ...evA, id: 1, syscall: 'prctl', args: ['0x1'], string_args: {},
        decoded_args: { '0': 'PR_GET_DUMPABLE' },
        backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] },
      { ...evA, id: 2, syscall: 'prctl', args: ['0x2'], string_args: {},
        decoded_args: { '0': 'PR_SET_DUMPABLE' },
        backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] },
      { ...evA, id: 3, syscall: 'prctl', args: ['0x3'], string_args: {},
        decoded_args: { '0': 'PR_SET_NAME' },
        backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] },
      { ...evA, id: 4, syscall: 'prctl', args: ['0x4'], string_args: {},
        decoded_args: { '0': 'PROT_READ|PROT_WRITE' },
        backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] },
      { ...evA, id: 5, syscall: 'openat', string_args: { '1': '/data/app/ok.so' },
        decoded_args: {} }, // different syscall, should not match
    ]
    const { runId } = await store.ingest(fixture(events))

    // Rule with path_matches operator
    const { rule: pathRule } = validateRule({
      id: 'test-decoded-path', category: 'hook', confidence: 0.8, rationale: 'test',
      source: 'project', enabled: true,
      steps: [{ syscalls: ['prctl'], field: 'decoded_args', op: 'path_matches', value: 'PR_(SET|GET)_DUMPABLE' }],
    }, 'project')
    expect(pathRule).not.toBeNull()

    // Test DuckDB WHERE clause against real database
    const where = compileWhere([pathRule!])
    const admitted = new Set(
      (await store.raw(`SELECT id FROM ev WHERE run_id = ${runId} AND (${where})`)).map(r => Number(r.id)),
    )

    // Test JS matcher for comparison
    const jsResult = matchSequences([pathRule!], events as any)
    const jsMatched = new Set(jsResult.hits.map((h) => {
      const evt = events.find((e: any) => e.backtrace === evA.backtrace)
      return events.findIndex((e: any) => e === evt || (e.syscall === 'prctl' && e.decoded_args['0']?.match(/PR_(SET|GET)_DUMPABLE/)))
    }))

    // Verify DuckDB admits exactly the events that path_matches events: ids 1 and 2
    expect(admitted).toEqual(new Set([1, 2]))

    // Verify agreement: for each event, DuckDB and JS must agree
    for (const e of events) {
      const jsMatches = matchSequences([pathRule!], [e as any]).hits.length > 0
      expect(admitted.has(e.id), `event ${e.id}: SQL=${admitted.has(e.id)} JS=${jsMatches}`).toBe(jsMatches)
    }

    await store.close()
  })

  it('DuckDB WHERE clause for decoded_args equals agrees with JS matcher', async () => {
    const store = new GraphStore()
    // Test events with decoded_args as complete composites
    const events = [
      { ...evA, id: 1, syscall: 'mprotect', args: ['0x1'], string_args: {},
        decoded_args: { '0': 'PROT_READ|PROT_WRITE' },
        backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] },
      { ...evA, id: 2, syscall: 'mprotect', args: ['0x2'], string_args: {},
        decoded_args: { '0': 'PROT_READ' },
        backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] },
      { ...evA, id: 3, syscall: 'mprotect', args: ['0x3'], string_args: {},
        decoded_args: { '0': 'PROT_EXEC' },
        backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] },
      { ...evA, id: 4, syscall: 'openat', string_args: { '1': '/ok' },
        decoded_args: {} }, // different syscall
    ]
    const { runId } = await store.ingest(fixture(events))

    // Rule with equals operator, matching a composite value
    const { rule: eqRule } = validateRule({
      id: 'test-decoded-equals', category: 'hook', confidence: 0.8, rationale: 'test',
      source: 'project', enabled: true,
      steps: [{ syscalls: ['mprotect'], field: 'decoded_args', op: 'equals', value: 'PROT_READ|PROT_WRITE' }],
    }, 'project')
    expect(eqRule).not.toBeNull()

    // Test DuckDB WHERE clause
    const where = compileWhere([eqRule!])
    const admitted = new Set(
      (await store.raw(`SELECT id FROM ev WHERE run_id = ${runId} AND (${where})`)).map(r => Number(r.id)),
    )

    // Verify DuckDB admits exactly event id 1 (the one with exact composite match)
    expect(admitted).toEqual(new Set([1]))

    // Verify agreement: for each event, DuckDB and JS must agree
    for (const e of events) {
      const jsMatches = matchSequences([eqRule!], [e as any]).hits.length > 0
      expect(admitted.has(e.id), `event ${e.id}: SQL=${admitted.has(e.id)} JS=${jsMatches}`).toBe(jsMatches)
    }

    await store.close()
  })
})

describe('arg_hex_in field integration', () => {
  it('DuckDB WHERE clause for arg_hex_in agrees with JS matcher, including the decimal spelling', async () => {
    const store = new GraphStore()
    // The tracer renders an arg either hex or decimal; a value the list carries
    // as '0x10' must also match the decimal spelling '16'.
    const events = [
      { ...evA, id: 1, syscall: 'ptrace', args: ['0x7'], string_args: {},
        backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] }, // hex-spelled match
      { ...evA, id: 2, syscall: 'ptrace', args: ['16'], string_args: {},
        backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] }, // decimal-spelled match (0x10)
      { ...evA, id: 3, syscall: 'ptrace', args: ['0x0'], string_args: {},
        backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] }, // non-match
    ]
    const { runId } = await store.ingest(fixture(events))

    const { rule } = validateRule({
      id: 'test-arg-hex-in', category: 'debugger', confidence: 0.8, rationale: 'test',
      source: 'project', enabled: true,
      steps: [{ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_in', argIndex: 0, value: '0x10 0x7 0x11' }],
    }, 'project')
    expect(rule).not.toBeNull()

    // Test DuckDB WHERE clause against real database
    const where = compileWhere([rule!])
    const admitted = new Set(
      (await store.raw(`SELECT id FROM ev WHERE run_id = ${runId} AND (${where})`)).map(r => Number(r.id)),
    )

    // Verify DuckDB admits exactly the hex-spelled and decimal-spelled matches: ids 1 and 2
    expect(admitted).toEqual(new Set([1, 2]))

    // Verify agreement: for each event, DuckDB and JS must agree - this is the
    // property the string-only compiler assertions cannot reach.
    for (const e of events) {
      const jsMatches = matchSequences([rule!], [e as any]).hits.length > 0
      expect(admitted.has(e.id), `event ${e.id}: SQL=${admitted.has(e.id)} JS=${jsMatches}`).toBe(jsMatches)
    }

    await store.close()
  })
})

describe('retval step modifier integration', () => {
  it('DuckDB WHERE clause for a retval condition agrees with JS matcher, including retval null', async () => {
    const store = new GraphStore()
    const events = [
      { ...evA, id: 1, syscall: 'faccessat', args: [], string_args: { '1': '/system/xbin/su' }, retval: 0,
        backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] }, // rooted: retval 0 matches
      { ...evA, id: 2, syscall: 'faccessat', args: [], string_args: { '1': '/system/xbin/su' }, retval: -2,
        backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] }, // ENOENT: not rooted, no match
      { ...evA, id: 3, syscall: 'faccessat', args: [], string_args: { '1': '/system/xbin/su' }, retval: null,
        backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] }, // enter-only record, no match
      { ...evA, id: 4, syscall: 'openat', string_args: { '1': '/system/xbin/su' }, retval: 0,
        decoded_args: {} }, // different syscall, should not match
    ]
    const { runId } = await store.ingest(fixture(events))

    const { rule } = validateRule({
      id: 'test-retval', category: 'root', confidence: 0.8, rationale: 'test',
      source: 'project', enabled: true,
      steps: [{ syscalls: ['faccessat'], field: 'string_args', op: 'path_matches', value: '(^|/)su$',
        retval: { op: 'eq', value: 0 } }],
    }, 'project')
    expect(rule).not.toBeNull()

    // Test DuckDB WHERE clause against real database
    const where = compileWhere([rule!])
    const admitted = new Set(
      (await store.raw(`SELECT id FROM ev WHERE run_id = ${runId} AND (${where})`)).map(r => Number(r.id)),
    )

    // Verify DuckDB admits exactly the retval-0 match: id 1
    expect(admitted).toEqual(new Set([1]))

    // Verify agreement: for each event, DuckDB and JS must agree - including the
    // retval:null event (id 3), which neither side may admit.
    for (const e of events) {
      const jsMatches = matchSequences([rule!], [e as any]).hits.length > 0
      expect(admitted.has(e.id), `event ${e.id}: SQL=${admitted.has(e.id)} JS=${jsMatches}`).toBe(jsMatches)
    }
    expect(admitted.has(3)).toBe(false)

    await store.close()
  })
})

describe("op: 'any' field integration", () => {
  it('DuckDB WHERE clause for a bare any op agrees with JS matcher, including a retval modifier', async () => {
    const store = new GraphStore()
    const events = [
      { ...evA, id: 1, syscall: 'process_vm_readv', args: [], string_args: {}, retval: 8,
        backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] }, // any + retval >= 1: matches
      { ...evA, id: 2, syscall: 'process_vm_readv', args: [], string_args: {}, retval: -1,
        backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] }, // retval fails the modifier
      { ...evA, id: 3, syscall: 'process_vm_readv', args: [], string_args: {}, retval: null,
        backtrace: [{ frame: 0, addr: '0x1000', symbol: 'libsentinel.so!chk+0x10' }] }, // enter-only record, no match
      { ...evA, id: 4, syscall: 'openat', string_args: { '1': '/system/xbin/su' }, retval: 8,
        decoded_args: {} }, // different syscall, should not match
    ]
    const { runId } = await store.ingest(fixture(events))

    const { rule } = validateRule({
      id: 'test-any-retval', category: 'integrity', confidence: 0.8, rationale: 'test',
      source: 'project', enabled: true,
      steps: [{ syscalls: ['process_vm_readv'], op: 'any', retval: { op: 'ge', value: 1 } }],
    }, 'project')
    expect(rule).not.toBeNull()

    // Test DuckDB WHERE clause against real database
    const where = compileWhere([rule!])
    const admitted = new Set(
      (await store.raw(`SELECT id FROM ev WHERE run_id = ${runId} AND (${where})`)).map(r => Number(r.id)),
    )

    // Verify DuckDB admits exactly the retval>=1 match: id 1
    expect(admitted).toEqual(new Set([1]))

    // Verify agreement: for each event, DuckDB and JS must agree - including the
    // retval:null event (id 3), which neither side may admit.
    for (const e of events) {
      const jsMatches = matchSequences([rule!], [e as any]).hits.length > 0
      expect(admitted.has(e.id), `event ${e.id}: SQL=${admitted.has(e.id)} JS=${jsMatches}`).toBe(jsMatches)
    }
    expect(admitted.has(3)).toBe(false)

    await store.close()
  })
})

describe('run diffing', () => {
  it('diffTable surfaces per-node presence and delta across two runs', async () => {
    const store = new GraphStore()
    const a = await store.ingest(fixture([evA])) // has nat:libexample.so!check_su + sys:openat
    const b = await store.ingest(fixture([
      { ...evA, syscall: 'read', string_args: {}, fd_args: { '0': '/proc/self/status' },
        backtrace: [{ frame: 0, addr: '0x9', symbol: 'libother.so!probe+0x4' }],
        java_stack: [] },
    ]))
    const rows = await store.diffTable(a.runId, b.runId)
    const byId = new Map(rows.map(r => [r.id, r]))
    expect(byId.get('sys:openat')!.presence).toBe('A-only')
    expect(byId.get('sys:read')!.presence).toBe('B-only')
    await store.close()
  })

  it('diffTable orders divergent rows before shared, even when a shared row has a bigger delta', async () => {
    const store = new GraphStore()
    // Run A: the same bridge five times -> shared nodes with a large |delta|.
    const a = await store.ingest(fixture([
      evA, { ...evA, id: 2 }, { ...evA, id: 3 }, { ...evA, id: 4 }, { ...evA, id: 5 },
    ]))
    // Run B: that bridge once (shared, delta -4) + a unique bridge (B-only, delta +1).
    const b = await store.ingest(fixture([
      evA,
      { ...evA, id: 2, syscall: 'read', string_args: {}, fd_args: { '0': '/proc/self/status' },
        java_stack: ['com.example.app.Other.x'],
        backtrace: [{ frame: 0, addr: '0x9', symbol: 'libother.so!probe+0x4' }] },
    ]))
    const rows = await store.diffTable(a.runId, b.runId)
    const idx = (p: string) => rows.map((r, i) => ({ p: r.presence, i })).filter(x => x.p === p).map(x => x.i)
    const divergentIdx = rows.map((r, i) => ({ p: r.presence, i })).filter(x => x.p !== 'both').map(x => x.i)
    const bothIdx = idx('both')
    // Magnitude alone would put the shared rows first...
    const bothMax = Math.max(...rows.filter(r => r.presence === 'both').map(r => Math.abs(r.delta)))
    const divMax = Math.max(...rows.filter(r => r.presence !== 'both').map(r => Math.abs(r.delta)))
    expect(bothMax).toBeGreaterThan(divMax)
    // ...but divergence-first wins: every divergent row precedes every shared row.
    expect(Math.max(...divergentIdx)).toBeLessThan(Math.min(...bothIdx))
    await store.close()
  })

  it('diffSlice returns a merged neighbourhood tagged by origin', async () => {
    const store = new GraphStore()
    const a = await store.ingest(fixture([evA]))
    const b = await store.ingest(fixture([{ ...evA, retval: -2 }])) // same chain, run B
    const merged = await store.diffSlice(a.runId, b.runId, 'sys:openat')
    expect(merged.nodes.find(n => n.id === 'sys:openat')!.presence).toBe('both')
    await store.close()
  })

  it('diffSlice honors the active filter (filtered-out neighbour drops from the same node neighbourhood)', async () => {
    const store = new GraphStore()
    // Two events share the native node + syscall but reach it from different tids
    // and java methods. Filtering by tid must prune one java neighbour of check_su.
    const mk = () => [
      evA, // tid 101, java RootCheck.run -> nat check_su -> sys openat
      { ...evA, id: 2, tid: 202, java_stack: ['com.example.app.Other.probe'] }, // same native+syscall, other branch
    ]
    const a = await store.ingest(fixture(mk()))
    const b = await store.ingest(fixture(mk()))
    const node = 'nat:libexample.so!check_su'
    const other = 'java:com.example.app.Other.probe'
    // Unfiltered: both java branches are neighbours of check_su.
    const unfiltered = await store.diffSlice(a.runId, b.runId, node)
    expect(unfiltered.nodes.some(n => n.id === other)).toBe(true)
    // Filtered to tid 101: the tid-202 branch (Other.probe) must be pruned.
    const filtered = await store.diffSlice(a.runId, b.runId, node, { tid: 101 })
    expect(filtered.nodes.some(n => n.id === other)).toBe(false)
    await store.close()
  })
})

describe('orphan detection', () => {
  it('orphanTargets returns only the targets absent from the run', async () => {
    const store = new GraphStore()
    await store.ingest(fixture([evA])) // nodes: java:...RootCheck.run, nat:libexample.so!check_su, sys:openat
    const targets = [
      'nat:libexample.so!check_su',   // present
      'sys:openat',                   // present
      'nat:libexample.so!removed',    // gone
      'edge:nat:libexample.so!check_su=>sys:openat', // present edge
      'edge:sys:openat=>sys:nope',    // gone edge
    ]
    const orphans = await store.orphanTargets(targets)
    expect(orphans.sort()).toEqual(['edge:sys:openat=>sys:nope', 'nat:libexample.so!removed'])
    await store.close()
  })
})

describe('mixed-engine retention: no regression on the syscall-only views', () => {
  it('retains funcs/correlate/coverage/sentinel rows without changing syscall eventCount/errors', async () => {
    const store = new GraphStore()
    const r = await store.ingest(MIXED_FIXTURE)
    // eventCount counts `type IN ('syscall', 'call')`: 4 syscalls (3 main + 1
    // correlate) plus 1 call = 5. A known, documented counter quirk, not a regression:
    // the query methods that matter (table/slice/stackRollup/...) all scope to
    // `span IS NULL` and are asserted byte-identical to the syscall-only fixture
    // in the next test. errors stays 0 - mixed.jsonl has no malformed line.
    expect(r.eventCount).toBe(5)
    expect(r.errors).toBe(0)
    const retained = await store.raw(`SELECT type, count(*) AS n FROM ev WHERE run_id = ${r.runId} GROUP BY type`)
    const byType = new Map(retained.map(row => [row.type as string, Number(row.n)]))
    expect(byType.get('call')).toBe(1)
    expect(byType.get('return')).toBe(1)
    expect(byType.get('func')).toBe(1) // correlate's span-open record
    expect(byType.get('coverage')).toBe(1)
    expect(byType.get('sentinel')).toBe(1)
    // correlate's own 'syscall' record (span-tagged) plus the main engine's 3 -> 4 total rows of type='syscall'.
    expect(byType.get('syscall')).toBe(4)
    await store.close()
  })

  it('table/stackRollup stay byte-identical; slice() folds in exactly what the foldFuncEvents oracle + mergeGraphs compute', async () => {
    const store = new GraphStore()
    const oracleRun = await store.ingest(FIXTURE)
    const mixedRun = await store.ingest(MIXED_FIXTURE)

    const tableOracle = await store.table({}, { limit: 100, offset: 0 }, oracleRun.runId)
    const tableMixed = await store.table({}, { limit: 100, offset: 0 }, mixedRun.runId)
    expect(tableMixed).toEqual(tableOracle)

    // slice() groups by unordered DuckDB aggregation, so row order isn't
    // guaranteed stable across runs with different underlying row layouts -
    // sort by id before comparing, same convention as the foldEvents oracle
    // test above.
    const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id))

    // slice() also folds in the funcs engine's own SQL chain, so mixed.jsonl's
    // foreign rows legitimately add graph content that oracle.jsonl (no such
    // data) doesn't have. Rather than hand-derive the expected numbers, compute
    // them the same way slice() does: fold the oracle's own syscalls, then
    // merge in the foldFuncEvents oracle over mixed.jsonl's own `call` rows.
    const mixedRaw = parseJsonl(readFileSync(MIXED_FIXTURE, 'utf-8')).events
    const mainSyscalls = mixedRaw.filter((e): e is SyscallEvent => e.type === 'syscall' && !('span' in e))
    const callRows = mixedRaw.filter((e): e is FuncEvent => e.type === 'call' && !('span' in e))
    const oracleFold = foldEvents(mainSyscalls)
    const expectedMixed = mergeGraphs(oracleFold, foldFuncEvents(callRows))

    const sliceOracle = await store.slice({}, undefined, oracleRun.runId)
    const sliceMixed = await store.slice({}, undefined, mixedRun.runId)
    expect(byId(sliceOracle.nodes)).toEqual(byId(oracleFold.nodes))
    expect(byId(sliceOracle.edges)).toEqual(byId(oracleFold.edges))
    expect(byId(sliceMixed.nodes)).toEqual(byId(expectedMixed.nodes))
    expect(byId(sliceMixed.edges)).toEqual(byId(expectedMixed.edges))
    // eventCount now unions the syscall and funcs scopes (slice()'s whole
    // point), so mixed.jsonl's one extra `call` row adds one to the oracle's.
    expect(sliceMixed.eventCount).toBe(sliceOracle.eventCount + callRows.length)
    expect(sliceMixed.truncated).toBe(sliceOracle.truncated)

    // table/stackRollup never fold in funcs chains (only slice() does), so
    // they stay fully byte-identical, unlike slice() above.
    const rollupOracle = await store.stackRollup({}, 5000, oracleRun.runId)
    const rollupMixed = await store.stackRollup({}, 5000, mixedRun.runId)
    const byChain = (rows: { chain: string[] }[]) => [...rows].sort((a, b) => a.chain.join('>').localeCompare(b.chain.join('>')))
    expect(byChain(rollupMixed.rows)).toEqual(byChain(rollupOracle.rows))
    expect(rollupMixed.eventCount).toBe(rollupOracle.eventCount)
    expect(rollupMixed.distinctChains).toBe(rollupOracle.distinctChains)
    expect(rollupMixed.truncated).toBe(rollupOracle.truncated)

    // diffTable is built on nodeCounts, which (like table/stackRollup) never
    // folds in funcs chains - still fully byte-identical/zero-delta.
    const diff = await store.diffTable(oracleRun.runId, mixedRun.runId)
    for (const row of diff) {
      expect(row.presence).toBe('both')
      expect(row.delta).toBe(0)
    }
    // diffSlice calls slice() for both runs, so it does see the funcs
    // addition; every node/edge that already existed in oracle's own slice
    // must still show 'both', anything new is 'B-only'.
    const oracleIds = new Set(sliceOracle.nodes.map(n => n.id))
    const mergedSlice = await store.diffSlice(oracleRun.runId, mixedRun.runId, 'sys:openat')
    for (const n of mergedSlice.nodes) expect(n.presence).toBe(oracleIds.has(n.id) ? 'both' : 'B-only')
    for (const e of mergedSlice.edges) {
      const bothEndpointsPreexisting = oracleIds.has(e.source) && oracleIds.has(e.target)
      expect(e.presence).toBe(bothEndpointsPreexisting ? 'both' : 'B-only')
    }

    await store.close()
  })
})

describe('stackRollup', () => {
  it('groups events by full chain with counts (unfiltered)', async () => {
    const store = new GraphStore()
    await store.ingest(FIXTURE)
    const r: StackRollup = await store.stackRollup()
    expect(r.eventCount).toBe(3)
    expect(r.distinctChains).toBe(2)
    const byLen = [...r.rows].sort((a, b) => b.count - a.count)
    expect(byLen[0].count).toBe(2)
    expect(byLen[0].chain).toEqual([
      'java:com.example.app.RootCheck.run',
      'nat:libexample.so!RootCheck_run',
      'nat:libexample.so!check_su',
      'sys:openat',
    ])
    expect(byLen[1].count).toBe(1)
    expect(byLen[1].chain).toEqual(['nat:libc.so!read', 'sys:read'])
    await store.close()
  })

  it('honors the has-java_stack filter', async () => {
    const store = new GraphStore()
    await store.ingest(FIXTURE)
    const r = await store.stackRollup({ hasJavaStack: true })
    expect(r.eventCount).toBe(2)
    expect(r.distinctChains).toBe(1)
    expect(r.rows[0].count).toBe(2)
    await store.close()
  })
})

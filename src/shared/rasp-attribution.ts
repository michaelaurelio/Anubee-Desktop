// Which node a syscall event's RASP finding belongs to: the app's own code, not
// the platform library it reached the kernel through. Pure so the attribution
// rules are unit-testable against hand-built backtraces.
import type { SyscallEvent } from './events'
import { chainOf } from './graph-shape'
import { parseFrameSymbol } from './frame-symbol'
import type { CorrelateKey } from './rasp-rules'
import type { RaspCategory } from './project-store'
import { classifyModule, type ModulePaths } from './module-origin'

// Java packages that belong to the platform, the language runtime, or a vendor
// framework - never the app's own RASP code. `miui.` earns its place: 26 of 39
// java-fallback attributions in a production capture landed on
// miui.content.res.ThemeResources before it was filtered.
const PLATFORM_JAVA = /^(java|javax|libcore|android|com\.android|androidx|dalvik|sun|jdk|org\.apache|kotlin|kotlinx|miui|com\.miui|com\.google\.android\.gms)\./

export type Attribution =
  | { kind: 'app-native'; id: string }
  | { kind: 'app-java'; id: string }
  | { kind: 'unattributed' }

// The synthetic target for a finding with no recoverable app-owned caller. It
// carries tags and dismissals like any other target but has NO graph node, so
// the renderer must not offer "reveal in graph" for a rasp: id.
export function unattributedId(category: RaspCategory): string {
  return `rasp:unattributed:${category}`
}

// Where a syscall event's RASP finding belongs. Preference order:
//   1. the innermost app-native frame (the app's own library),
//   2. the innermost java frame that is not platform/vendor framework code,
//   3. nothing - Anubee caps java_stack and appends a literal '...' for the
//      frames it dropped, and it drops the OUTERMOST ones, which is exactly
//      where a deep Kotlin/Compose stack keeps the app's own caller.
// chainOf runs outermost -> innermost, so both loops walk it backwards to reach
// the innermost frame of each kind first.
export function attributionOf(e: SyscallEvent, paths: ModulePaths): Attribution {
  const chain = chainOf(e)
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i]
    if (c.kind === 'native' && classifyModule(c.module, paths) === 'app-native') {
      return { kind: 'app-native', id: c.id }
    }
  }
  const java = appJavaId(e)
  if (java !== null) return { kind: 'app-java', id: java }
  return { kind: 'unattributed' }
}

// The `java:` node id of the innermost java frame that is the app's own code, or
// null when the stack has none. Shared by the attribution fallback and the java
// correlation key so the two can never disagree on what "the app's java frame"
// means.
function appJavaId(e: SyscallEvent): string | null {
  const chain = chainOf(e)
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i]
    if (c.kind !== 'java') continue
    // chainOf has already stripped the '+0x<dex-pc>' suffix, so the package test
    // sees the same string the java: node id carries.
    const method = c.id.slice('java:'.length)
    if (method === '...' || PLATFORM_JAVA.test(method)) continue
    return c.id
  }
  return null
}

export interface Frame { module: string; addr: string }

// The anchor frame for a hit: the innermost app-native frame's raw address and
// module. Null when the event is attributed to a java frame or to nothing, which
// has no load address to make module-relative.
export function anchorFrame(e: SyscallEvent, paths: ModulePaths): Frame | null {
  for (const f of e.backtrace) {
    const p = parseFrameSymbol(f.symbol)
    if (p.module === null) continue
    if (classifyModule(p.module, paths) !== 'app-native') continue
    return { module: p.module, addr: f.addr }
  }
  return null
}

// The correlation key for one event under one mode, or null when the event has
// no origin of that kind (it then participates in no sequence for that rule).
export function correlationKey(mode: CorrelateKey, e: SyscallEvent, paths: ModulePaths): string | null {
  if (mode === 'java') {
    // Keys on the app's own java frame whether or not the event also has an
    // app-native frame - the mode asks for the managed caller, not for the
    // event's overall attribution. No key when every java frame is platform or
    // vendor code. Deliberate: a `libcore.io.BlockGuardOs` key would group
    // unrelated checks together, so a rule correlating on java participates in
    // no sequence for such an event.
    return appJavaId(e)
  }
  let base: string | null
  if (mode === 'module' || mode === 'module+tid') {
    // A module key needs an app-native frame; there is no module to key on for a
    // java-attributed or unattributed event.
    const f = anchorFrame(e, paths)
    if (f === null) return null
    base = `mod:${f.module}`
  } else {
    // symbol / symbol+tid key on the attributed target, which falls back to the
    // innermost app java frame when the app has no custom native lib in the stack.
    const a = attributionOf(e, paths)
    base = a.kind === 'unattributed' ? null : a.id
  }
  if (base === null) return null
  return mode.endsWith('+tid') ? `${base}#${e.tid}` : base
}

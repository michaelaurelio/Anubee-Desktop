// Which node a syscall event's RASP finding belongs to: the app's own code, not
// the platform library it reached the kernel through. Pure so the attribution
// rules are unit-testable against hand-built backtraces.
import type { SyscallEvent } from './events'
import { chainOf } from './graph-shape'
import { parseFrameSymbol } from './frame-symbol'
import type { CorrelateKey } from './rasp-rules'

// Native modules that belong to the platform, not the traced app: bionic, the
// ART/managed runtime, and the logging/base/framework core. A RASP check almost
// always runs in the app's own (often obfuscated) library and reaches a syscall
// *through* these, so they are the wrong thing to tag. Matched by basename.
const SYSTEM_NATIVE = new Set<string>([
  // bionic
  'libc.so', 'libm.so', 'libdl.so', 'libc++.so', 'libc++_shared.so', 'libstdc++.so',
  'linker64', 'linker',
  // ART / managed runtime
  'libart.so', 'libartbase.so', 'libartpalette.so', 'libart-compiler.so',
  'libopenjdk.so', 'libopenjdkjvm.so', 'libopenjdkjvmti.so', 'libjavacore.so',
  'libnativehelper.so', 'libnativeloader.so', 'libnativebridge.so',
  'libdexfile.so', 'libprofile.so', 'libsigchain.so',
  // logging / base / framework core
  'liblog.so', 'libbase.so', 'libcutils.so', 'libutils.so', 'libbinder.so',
  'libandroid_runtime.so', 'libandroidicu.so',
])

// A frame that can never be the app's own RASP code: a platform lib, or a
// synthetic/non-file region ([anon], [vdso], [JIT], [stack], ...).
function isSystemNative(module: string | null): boolean {
  if (module === null) return true
  if (module.startsWith('[')) return true
  return SYSTEM_NATIVE.has(module)
}

// The node id of the RASP block behind the syscall: the innermost native frame
// that is NOT a platform lib (the app's own code that called into libc). A stack
// that never leaves platform code is not app RASP code, so it yields no target -
// falling back to the libc wrapper used to suggest libart.so as a hook check.
// A managed-code check with no custom native lib falls back to its innermost
// java frame. Reuses chainOf so the id grammar matches the graph exactly.
export function targetOf(e: SyscallEvent): string | null {
  const chain = chainOf(e)
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i]
    if (c.kind === 'native' && !isSystemNative(c.module)) return c.id
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].kind === 'java') return chain[i].id
  }
  return null
}

export interface Frame { module: string; addr: string }

// The anchor frame for a hit: the innermost non-platform native frame's raw
// address and module. Null when the event is attributed to a java frame, which
// has no load address to make module-relative.
export function anchorFrame(e: SyscallEvent): Frame | null {
  for (const f of e.backtrace) {
    const p = parseFrameSymbol(f.symbol)
    if (p.module === null || isSystemNative(p.module)) continue
    return { module: p.module, addr: f.addr }
  }
  return null
}

// The correlation key for one event under one mode, or null when the event has
// no origin of that kind (it then participates in no sequence for that rule).
export function correlationKey(mode: CorrelateKey, e: SyscallEvent): string | null {
  if (mode === 'java') {
    const chain = chainOf(e)
    for (let i = chain.length - 1; i >= 0; i--) if (chain[i].kind === 'java') return chain[i].id
    return null
  }
  let base: string | null
  if (mode === 'module' || mode === 'module+tid') {
    // A module key needs a non-platform native frame; there is no module to key
    // on for a java-attributed event.
    const f = anchorFrame(e)
    if (f === null) return null
    base = `mod:${f.module}`
  } else {
    // symbol / symbol+tid key on the graph target, which falls back to the
    // innermost java frame when the app has no custom native lib in the stack.
    base = targetOf(e)
  }
  if (base === null) return null
  return mode.endsWith('+tid') ? `${base}#${e.tid}` : base
}

import { describe, it, expect } from 'vitest'
import { attributionOf, anchorFrame, correlationKey, unattributedId } from '../src/shared/rasp-attribution'
import type { ModulePaths } from '../src/shared/module-origin'
import type { SyscallEvent } from '../src/shared/events'

const paths: ModulePaths = new Map([
  ['libsentinel.so', '/data/app/~~a==/dev.anubee.detector-b==/lib/arm64/libsentinel.so'],
  ['libc.so', '/apex/com.android.runtime/lib64/bionic/libc.so'],
  ['boot.oat', '/apex/com.android.art/javalib/arm64/boot.oat'],
  ['base.vdex', '/data/app/~~a==/dev.anubee.detector-b==/oat/arm64/base.vdex'],
])

function ev(over: Partial<SyscallEvent>): SyscallEvent {
  return {
    type: 'syscall', id: 1, pid: 100, tid: 100, syscall_nr: 0, syscall: 'openat',
    args: [], retval: 0, string_args: {}, fd_args: {}, decoded_args: {}, backtrace: [], ...over,
  } as SyscallEvent
}

describe('attributionOf', () => {
  it('names the innermost app-native frame', () => {
    const a = attributionOf(ev({ backtrace: [
      { frame: 0, addr: '0x1', symbol: 'libc.so!__openat+0x8' },
      { frame: 1, addr: '0x2', symbol: 'libsentinel.so!check_root+0x4c' },
    ] }), paths)
    expect(a).toEqual({ kind: 'app-native', id: 'nat:libsentinel.so!check_root' })
  })

  it('never names an ART AOT artefact', () => {
    const a = attributionOf(ev({
      backtrace: [
        { frame: 0, addr: '0x1', symbol: 'libc.so!__faccessat+0x8' },
        { frame: 1, addr: '0x2', symbol: 'boot.oat!art_jni_trampoline+0x80' },
      ],
      java_stack: ['dev.anubee.detector.RootCheck.run', 'java.io.File.exists', '...'],
    }), paths)
    expect(a).toEqual({ kind: 'app-java', id: 'java:dev.anubee.detector.RootCheck.run' })
  })

  it('skips platform java packages, including miui', () => {
    const a = attributionOf(ev({
      backtrace: [{ frame: 0, addr: '0x1', symbol: 'boot.oat!art_jni_trampoline+0x80' }],
      java_stack: ['libcore.io.BlockGuardOs.access', 'java.io.File.exists',
                   'miui.content.res.ThemeResources.checkUpdate', '...'],
    }), paths)
    expect(a).toEqual({ kind: 'unattributed' })
  })

  it('is unattributed when the backtrace is platform-only and there is no java stack', () => {
    const a = attributionOf(ev({ backtrace: [{ frame: 0, addr: '0x1', symbol: 'libc.so!__openat+0x8' }] }), paths)
    expect(a).toEqual({ kind: 'unattributed' })
  })

  it('is unattributed when base.vdex is the only non-libc frame', () => {
    const a = attributionOf(ev({ backtrace: [
      { frame: 0, addr: '0x1', symbol: 'libc.so!__faccessat+0x8' },
      { frame: 1, addr: '0x2', symbol: 'base.vdex+0x116a75a' },
    ] }), paths)
    expect(a).toEqual({ kind: 'unattributed' })
  })

  it('strips a dex-pc suffix before testing a java frame for a platform package', () => {
    // Real captures carry '+0x<pc>' on every java frame. The platform filter runs
    // on chainOf's cleaned name, so 'dalvik.system...' is still recognised.
    const a = attributionOf(ev({
      backtrace: [{ frame: 0, addr: '0x1', symbol: 'boot.oat!art_jni_trampoline+0x80' }],
      java_stack: ['dalvik.system.ZygoteHooks.postForkChild+0x64',
                   'com.android.internal.os.Zygote.callPostForkChildHooks+0x28'],
    }), paths)
    expect(a).toEqual({ kind: 'unattributed' })
  })

  it('names a java frame without its dex-pc suffix', () => {
    const a = attributionOf(ev({
      backtrace: [{ frame: 0, addr: '0x1', symbol: 'boot.oat!art_jni_trampoline+0x80' }],
      java_stack: ['dev.anubee.detector.RootCheck.run+0x1a'],
    }), paths)
    expect(a).toEqual({ kind: 'app-java', id: 'java:dev.anubee.detector.RootCheck.run' })
  })

  it('never names the truncation marker Anubee appends to a capped java stack', () => {
    // The tracer caps java_stack and appends a literal '...' for the frames it
    // dropped. chainOf turns that into a java: node; it is not a method.
    const a = attributionOf(ev({
      backtrace: [{ frame: 0, addr: '0x1', symbol: 'boot.oat!art_jni_trampoline+0x80' }],
      java_stack: ['java.io.File.exists', '...'],
    }), paths)
    expect(a).toEqual({ kind: 'unattributed' })
  })

  it('prefers the app-native frame over an equally valid app java frame', () => {
    // Both fallbacks are available and yield different ids, so this fails if the
    // java loop runs first rather than merely returning the same answer.
    const a = attributionOf(ev({
      backtrace: [
        { frame: 0, addr: '0x1', symbol: 'libc.so!__openat+0x8' },
        { frame: 1, addr: '0x2', symbol: 'libsentinel.so!check_root+0x4c' },
      ],
      java_stack: ['dev.anubee.detector.RootCheck.run'],
    }), paths)
    expect(a).toEqual({ kind: 'app-native', id: 'nat:libsentinel.so!check_root' })
  })

  it('picks the innermost of two app-native frames', () => {
    // backtrace is innermost-first, so libsentinel.so is the closer caller. An
    // outermost-first scan would name libhelper.so instead.
    const a = attributionOf(ev({ backtrace: [
      { frame: 0, addr: '0x1', symbol: 'libc.so!__openat+0x8' },
      { frame: 1, addr: '0x2', symbol: 'libsentinel.so!check_root+0x4c' },
      { frame: 2, addr: '0x3', symbol: 'libhelper.so!dispatch+0x10' },
    ] }), paths)
    expect(a).toEqual({ kind: 'app-native', id: 'nat:libsentinel.so!check_root' })
  })

  it('picks the innermost of two app java frames', () => {
    // java_stack is innermost-first too, so the check method is frame 0 and its
    // caller is frame 1. An outermost-first scan would name the caller.
    const a = attributionOf(ev({
      backtrace: [{ frame: 0, addr: '0x1', symbol: 'boot.oat!art_jni_trampoline+0x80' }],
      java_stack: ['dev.anubee.detector.RootCheck.run', 'dev.anubee.detector.App.onCreate'],
    }), paths)
    expect(a).toEqual({ kind: 'app-java', id: 'java:dev.anubee.detector.RootCheck.run' })
  })

  it('falls back to the basename denylist when no load path is known', () => {
    const a = attributionOf(ev({ backtrace: [
      { frame: 0, addr: '0x1', symbol: 'libc.so!__openat+0x8' },
      { frame: 1, addr: '0x2', symbol: 'libunknown.so!probe+0x4' },
    ] }), new Map())
    expect(a).toEqual({ kind: 'app-native', id: 'nat:libunknown.so!probe' })
  })
})

describe('anchorFrame', () => {
  it('returns the app-native frame module and raw address', () => {
    expect(anchorFrame(ev({ backtrace: [
      { frame: 0, addr: '0x1', symbol: 'libc.so!__openat+0x8' },
      { frame: 1, addr: '0x2100', symbol: 'libsentinel.so!check_root+0x4c' },
    ] }), paths)).toEqual({ module: 'libsentinel.so', addr: '0x2100' })
  })

  it('returns null when no app-native frame exists', () => {
    expect(anchorFrame(ev({ backtrace: [
      { frame: 0, addr: '0x1', symbol: 'boot.oat!art_jni_trampoline+0x80' },
    ] }), paths)).toBeNull()
  })
})

describe('correlationKey', () => {
  const appNative = ev({ backtrace: [
    { frame: 0, addr: '0x1', symbol: 'libc.so!__openat+0x8' },
    { frame: 1, addr: '0x2100', symbol: 'libsentinel.so!check_root+0x4c' },
  ] })

  it('keys symbol mode on the attributed target', () => {
    expect(correlationKey('symbol', appNative, paths)).toBe('nat:libsentinel.so!check_root')
    expect(correlationKey('symbol+tid', appNative, paths)).toBe('nat:libsentinel.so!check_root#100')
  })

  it('keys module mode on the anchor frame module', () => {
    expect(correlationKey('module', appNative, paths)).toBe('mod:libsentinel.so')
    expect(correlationKey('module+tid', appNative, paths)).toBe('mod:libsentinel.so#100')
  })

  it('keys java mode on the app java frame', () => {
    const e = ev({
      backtrace: [{ frame: 0, addr: '0x1', symbol: 'boot.oat!art_jni_trampoline+0x80' }],
      java_stack: ['dev.anubee.detector.RootCheck.run', 'java.io.File.exists'],
    })
    expect(correlationKey('java', e, paths)).toBe('java:dev.anubee.detector.RootCheck.run')
  })

  it('keys java mode on the java frame even when an app-native frame exists', () => {
    // The mode asks for the managed caller, not for the event's attribution, so
    // an app-native frame must not suppress the key.
    const e = ev({
      backtrace: [
        { frame: 0, addr: '0x1', symbol: 'libc.so!__openat+0x8' },
        { frame: 1, addr: '0x2100', symbol: 'libsentinel.so!check_root+0x4c' },
      ],
      java_stack: ['dev.anubee.detector.RootCheck.run'],
    })
    expect(correlationKey('java', e, paths)).toBe('java:dev.anubee.detector.RootCheck.run')
    expect(attributionOf(e, paths)).toEqual({ kind: 'app-native', id: 'nat:libsentinel.so!check_root' })
  })

  it('yields no java key when every java frame is platform or vendor code', () => {
    // Deliberate: a libcore.io.BlockGuardOs key would group unrelated checks.
    const e = ev({
      backtrace: [{ frame: 0, addr: '0x1', symbol: 'boot.oat!art_jni_trampoline+0x80' }],
      java_stack: ['libcore.io.BlockGuardOs.access', 'miui.content.res.ThemeResources.checkUpdate'],
    })
    expect(correlationKey('java', e, paths)).toBeNull()
  })

  it('yields no module key for a java-attributed event', () => {
    const e = ev({
      backtrace: [{ frame: 0, addr: '0x1', symbol: 'boot.oat!art_jni_trampoline+0x80' }],
      java_stack: ['dev.anubee.detector.RootCheck.run'],
    })
    expect(correlationKey('module', e, paths)).toBeNull()
  })
})

describe('unattributedId', () => {
  it('mints one synthetic target per category', () => {
    expect(unattributedId('root')).toBe('rasp:unattributed:root')
    expect(unattributedId('hook')).toBe('rasp:unattributed:hook')
  })
})

describe('invariant: non-null correlation key implies app-native attribution', () => {
  it('a module key with app-native frame gives app-native attribution', () => {
    const e = ev({ backtrace: [
      { frame: 0, addr: '0x1', symbol: 'libc.so!__openat+0x8' },
      { frame: 1, addr: '0x2', symbol: 'libsentinel.so!check_root+0x4c' },
    ] })
    const key = correlationKey('module', e, paths)
    expect(key).not.toBeNull()
    expect(attributionOf(e, paths).kind).toBe('app-native')
  })

  it('a platform-only backtrace gives no module key and unattributed', () => {
    const e = ev({ backtrace: [{ frame: 0, addr: '0x1', symbol: 'libc.so!__openat+0x8' }] })
    const key = correlationKey('module', e, paths)
    expect(key).toBeNull()
    expect(attributionOf(e, paths).kind).toBe('unattributed')
  })
})

import { describe, it, expect } from 'vitest'
import { classifyModule, type ModulePaths } from '../src/shared/module-origin'

const paths: ModulePaths = new Map([
  ['libsentinel.so', '/data/app/~~abc==/dev.anubee.detector-xyz==/lib/arm64/libsentinel.so'],
  ['libc.so', '/apex/com.android.runtime/lib64/bionic/libc.so'],
  ['libhwui.so', '/system/lib64/libhwui.so'],
  ['libforcedarkimpl.so', '/system_ext/lib64/libforcedarkimpl.so'],
  ['boot.oat', '/apex/com.android.art/javalib/arm64/boot.oat'],
  ['base.vdex', '/data/app/~~abc==/dev.anubee.detector-xyz==/oat/arm64/base.vdex'],
  ['base.apk', '/data/app/~~abc==/dev.anubee.detector-xyz==/base.apk'],
  ['classes.odex', '/data/misc/apexdata/com.android.art/dalvik-cache/arm64/classes.odex'],
])

describe('classifyModule', () => {
  it('calls a library loaded from /data/app app-native', () => {
    expect(classifyModule('libsentinel.so', paths)).toBe('app-native')
  })

  it('calls an APK-embedded library app-native without needing a lib record', () => {
    expect(classifyModule('base.apk -> libsentinel.so', new Map())).toBe('app-native')
    // Discriminating case: the composite string ends in a managed suffix, so if the
    // " -> " check ran after the map lookup, the fallback would wrongly call this
    // 'managed' instead of 'app-native'.
    expect(classifyModule('base.apk -> classes.odex', new Map())).toBe('app-native')
  })

  it('calls ART AOT artefacts managed even under /data/app', () => {
    for (const m of ['boot.oat', 'base.vdex', 'base.apk', 'classes.odex']) {
      expect(classifyModule(m, paths), m).toBe('managed')
    }
  })

  it('calls system, system_ext and apex libraries platform', () => {
    for (const m of ['libc.so', 'libhwui.so', 'libforcedarkimpl.so']) {
      expect(classifyModule(m, paths), m).toBe('platform')
    }
  })

  it('calls synthetic regions and unresolved frames platform', () => {
    for (const m of [null, '[anon:dalvik-DEX data]', '[vdso]', '[JIT]']) {
      expect(classifyModule(m, paths), String(m)).toBe('platform')
    }
  })

  it('falls back to the basename denylist when no lib record exists', () => {
    expect(classifyModule('libc.so', new Map())).toBe('platform')
    expect(classifyModule('libart.so', new Map())).toBe('platform')
    expect(classifyModule('linker64', new Map())).toBe('platform')
  })

  it('treats an unknown module with no lib record as app-native', () => {
    // Erring toward app-native keeps a real finding attributable; erring toward
    // platform would silently drop it.
    expect(classifyModule('libmystery.so', new Map())).toBe('app-native')
  })

  it('classifies every platform root as platform', () => {
    const roots: [string, string][] = [
      ['libvendorthing.so', '/vendor/lib64/libvendorthing.so'],
      ['libproductthing.so', '/product/lib64/libproductthing.so'],
      ['libodmthing.so', '/odm/lib64/libodmthing.so'],
      ['libapexthing.so', '/data/misc/apexdata/com.android.art/lib64/libapexthing.so'],
      ['libcachething.so', '/data/dalvik-cache/arm64/libcachething.so'],
    ]
    for (const [base, path] of roots) {
      expect(classifyModule(base, new Map([[base, path]])), path).toBe('platform')
    }
  })

  it('classifies bare addresses as platform', () => {
    expect(classifyModule('0x7284edac18', new Map())).toBe('platform')
  })

  it('classifies unmapped managed artefacts as managed', () => {
    expect(classifyModule('base.apk', new Map())).toBe('managed')
  })

  it('classifies mapped paths outside known roots as platform', () => {
    expect(classifyModule('libodd.so', new Map([['libodd.so', '/opt/weird/libodd.so']]))).toBe('platform')
  })
})

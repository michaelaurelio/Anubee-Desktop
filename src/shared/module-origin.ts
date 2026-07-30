// Which side of the fence a native module sits on: the traced app's own code,
// the ART managed/AOT layer, or the platform. Classified from the module's real
// load path (Anubee's `lib` records carry it), because a basename denylist can
// never keep up with the platform - one device capture alone adds libselinux,
// libhwui, libgui, libui, libandroidfw, libvndksupport, libdl_android and a
// dozen vendor libraries. Pure and DB-free so it is unit-tested in isolation.

export type ModuleClass = 'app-native' | 'managed' | 'platform'

// Module basename -> full load path, built from `lib` records at ingest.
export type ModulePaths = ReadonlyMap<string, string>

// ART AOT / dex artefacts. These are the app's *managed* code, not its native
// code: attributing a finding to `boot.oat` or `base.vdex` names the compiler's
// output, not the check.
const MANAGED_SUFFIX = /\.(oat|art|vdex|odex|jar|apk)$/

// Platform install roots. Anything loaded from here belongs to the OS image.
const PLATFORM_ROOTS = [
  '/system/', '/system_ext/', '/vendor/', '/product/', '/odm/', '/apex/',
  '/data/misc/apexdata/', '/data/dalvik-cache/',
]

// Fallback only, for a module with no `lib` record: bionic, the ART runtime, and
// the logging/base/framework core.
const SYSTEM_NATIVE = new Set<string>([
  'libc.so', 'libm.so', 'libdl.so', 'libc++.so', 'libc++_shared.so', 'libstdc++.so',
  'linker64', 'linker',
  'libart.so', 'libartbase.so', 'libartpalette.so', 'libart-compiler.so',
  'libopenjdk.so', 'libopenjdkjvm.so', 'libopenjdkjvmti.so', 'libjavacore.so',
  'libnativehelper.so', 'libnativeloader.so', 'libnativebridge.so',
  'libdexfile.so', 'libprofile.so', 'libsigchain.so',
  'liblog.so', 'libbase.so', 'libcutils.so', 'libutils.so', 'libbinder.so',
  'libandroid_runtime.so', 'libandroidicu.so', 'libselinux.so', 'libdl_android.so',
  'libvndksupport.so',
])

export function classifyModule(module: string | null, paths: ModulePaths): ModuleClass {
  if (module === null) return 'platform'
  // Bare-address and synthetic regions ([anon:*], [vdso], [JIT], [stack]).
  if (module.startsWith('0x') || module.startsWith('[')) return 'platform'
  // "base.apk -> inner.so": a library bundled inside the app's own APK. Always
  // the app's, and it never gets its own `lib` record under that composite name.
  if (module.includes(' -> ')) return 'app-native'

  const path = paths.get(module)
  if (path === undefined) {
    if (MANAGED_SUFFIX.test(module)) return 'managed'
    if (SYSTEM_NATIVE.has(module)) return 'platform'
    // Unknown and unmapped: prefer app-native. A wrong 'platform' silently drops
    // a real finding; a wrong 'app-native' merely names an odd node the analyst
    // can see and reject.
    return 'app-native'
  }
  if (MANAGED_SUFFIX.test(path)) return 'managed'
  if (PLATFORM_ROOTS.some(r => path.startsWith(r))) return 'platform'
  if (path.startsWith('/data/app/')) return 'app-native'
  return 'platform'
}

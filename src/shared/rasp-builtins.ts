import type { Rule } from './rasp-rules'
import { coerceRules } from './rasp-rules'

// Built-in rules as raw specs, validated at module load. A malformed built-in
// throws here rather than disappearing quietly, and defaults (enabled, correlate,
// maxGap, mode, minOccurrences) are supplied by validateRule.
//
// ptrace's request argument is NOT decoded to a name by the tracer - it is raw
// args[0], matched here as hex. PTRACE_TRACEME === 0 and PTRACE_ATTACH === 0x10.
//
// Every regex and threshold here was measured against two real captures: the
// maintainer's reference detector app and a production Android app held outside
// the repository. A rule marked "unfired" scored zero on both because the
// capture device is clean and unrooted - it is correctly silent, not validated.
export const BUILTIN_SPECS: unknown[] = [
  // ------------------------------------------------------------------ root ---
  { id: 'root-paths', category: 'root', confidence: 0.85,
    rationale: 'probe of a root-indicator path (su/magisk/busybox/xbin/sbin/data-adb)',
    steps: [{ syscalls: ['openat', 'access', 'faccessat', 'newfstatat', 'statfs', 'execve'],
      field: 'string_args', op: 'path_matches',
      value: '(^|/)su$|magisk|busybox|/system/xbin|/sbin(/|$)|/data/adb|supersu|daemonsu|supolicy|Superuser\\.apk|SuperSu\\.apk|/su/bin|/system/bin/\\.ext' }] },
  { id: 'root-found', category: 'root', confidence: 0.95,
    rationale: 'a root binary or artefact was probed AND exists (retval 0) - the device is rooted. Binaries only: /system/xbin and /sbin are stock directories',
    steps: [{ syscalls: ['openat', 'access', 'faccessat', 'newfstatat', 'statfs'],
      field: 'string_args', op: 'path_matches',
      value: '(^|/)(su|magisk|magiskpolicy|busybox|daemonsu|supolicy|noxsu)$|Superuser\\.apk|SuperSu\\.apk|/data/adb/(magisk|ksu)|supersu_is_here|app_process(32|64)?_original',
      retval: { op: 'eq', value: 0 } }] },
  { id: 'root-shell-probe', category: 'root', confidence: 0.6,
    rationale: 'execve of a shell utility - shelling out to "which su" / "ps" is a common root check',
    steps: [{ syscalls: ['execve'], field: 'string_args', op: 'path_matches', value: '/(sh|which|ps|mount|getprop|id)$' }] },
  { id: 'root-kernel-files', category: 'root', confidence: 0.5,
    rationale: 'read of /proc/modules, /proc/filesystems, /proc/mounts or /proc/self/mountinfo - kernel-module / mount-posture check',
    steps: [{ syscalls: ['openat', 'access', 'faccessat', 'newfstatat'], field: 'string_args', op: 'path_matches',
      value: '/proc/(modules|filesystems|mounts)$|/proc/self/mountinfo$' }] },
  { id: 'root-selinux', category: 'root', confidence: 0.8,
    rationale: 'access of /sys/fs/selinux - SELinux-posture / root tell',
    steps: [{ syscalls: ['openat', 'newfstatat', 'faccessat', 'statfs'], field: 'string_args', op: 'path_matches',
      value: '/sys/fs/selinux' }] },
  { id: 'root-ksu-prctl', category: 'root', confidence: 0.9,
    rationale: 'prctl(0xdeadbeef) - KernelSU magic prctl probe (unfired on available captures)',
    steps: [{ syscalls: ['prctl'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0xdeadbeef' }] },

  // -------------------------------------------------------------- debugger ---
  { id: 'dbg-tracerpid', category: 'debugger', confidence: 0.6,
    rationale: 'open of /proc/<pid>/status - TracerPid debugger check. Matches the numeric-pid form, which is what real code emits',
    steps: [{ syscalls: ['openat', 'newfstatat'], field: 'string_args', op: 'path_matches',
      value: '/proc/(self|thread-self|[0-9]+)/status$' }] },
  { id: 'dbg-ptrace-traceme', category: 'debugger', confidence: 0.9,
    rationale: 'ptrace(PTRACE_TRACEME) - classic anti-debug self-attach (unfired on available captures)',
    steps: [{ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0x0' }] },
  { id: 'dbg-ptrace-selftrace', category: 'debugger', confidence: 0.85, minOccurrences: 10,
    rationale: 'a ptrace ATTACH/CONT/DETACH/KILL/SETOPTIONS loop - the app traces its own threads so a real debugger cannot attach',
    steps: [{ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_in', argIndex: 0, value: '0x10 0x7 0x11 0x8 0x4206' }] },
  { id: 'dbg-tracer-fork', category: 'debugger', confidence: 0.9, mode: 'unordered',
    correlate: 'module+tid', maxGap: 200,
    rationale: 'ptrace, wait4 and getppid on one thread - the fork-and-trace anti-debug pattern',
    steps: [
      { syscalls: ['ptrace'], op: 'any' },
      { syscalls: ['wait4'], op: 'any' },
      { syscalls: ['getppid'], op: 'any' },
    ] },
  { id: 'dbg-prctl-antidebug', category: 'debugger', confidence: 0.5, minOccurrences: 5,
    rationale: 'prctl PR_SET/GET_DUMPABLE or PR_SET_SECCOMP - anti-dump / sandbox hardening. The platform graphics stack also calls PR_SET_DUMPABLE, hence the low confidence',
    steps: [{ syscalls: ['prctl'], field: 'decoded_args', op: 'path_matches',
      value: 'PR_(SET|GET)_DUMPABLE|PR_SET_SECCOMP' }] },
  { id: 'dbg-ftrace', category: 'debugger', confidence: 0.7,
    rationale: 'probe of the kernel ftrace interface - checks whether a kernel tracer is active',
    steps: [{ syscalls: ['openat', 'access', 'faccessat', 'newfstatat'], field: 'string_args', op: 'path_matches',
      value: '/sys/kernel/(debug/)?tracing/|/proc/sys/kernel/ftrace_enabled' }] },

  // ------------------------------------------------------------------ hook ---
  { id: 'hook-maps-open', category: 'hook', confidence: 0.4,
    rationale: 'open of /proc/<pid>/maps or smaps - hook/injection scan; weak alone, see hook-maps-scan and hook-frida-scan',
    steps: [{ syscalls: ['openat', 'newfstatat', 'faccessat'], field: 'string_args', op: 'path_matches',
      value: '/proc/(self|thread-self|[0-9]+)/s?maps$' }] },
  { id: 'hook-maps-scan', category: 'hook', confidence: 0.8, minOccurrences: 50,
    rationale: 'sustained reading of /proc/<pid>/maps or smaps - a memory-map integrity or injected-region scan',
    steps: [{ syscalls: ['read', 'pread64', 'lseek', 'getdents64'], field: 'fd_args', op: 'path_matches',
      value: '/proc/(self|[0-9]+)/s?maps$' }] },
  { id: 'hook-frida-artefact', category: 'hook', confidence: 0.95,
    rationale: 'probe for a frida artefact by name. Tokens are anchored: a bare "gadget" matches usb.gadget HALs and theme files',
    steps: [{ syscalls: ['openat', 'access', 'faccessat', 'newfstatat', 'readlinkat', 'execve'],
      field: 'string_args', op: 'path_matches',
      value: 'frida-(agent|gadget|server)|libfrida|re\\.frida|linjector|gum-js-loop' }] },
  { id: 'hook-frida-port', category: 'hook', confidence: 0.9,
    rationale: 'bind or connect on frida default port 27042/27043 - either probing for frida-server or squatting the port so it cannot start',
    steps: [{ syscalls: ['bind', 'connect'], field: 'sock_addr', op: 'path_matches', value: ':(27042|27043)$' }] },
  { id: 'hook-frida-port-taken', category: 'hook', confidence: 0.99,
    rationale: 'bind on frida port failed with EADDRINUSE - frida-server is already listening (unfired on available captures)',
    steps: [{ syscalls: ['bind'], field: 'sock_addr', op: 'path_matches', value: ':(27042|27043)$',
      retval: { op: 'eq', value: -98 } }] },
  { id: 'hook-thread-comm-scan', category: 'hook', confidence: 0.75, minOccurrences: 20,
    rationale: 'enumeration of every thread name via /proc/<pid>/task/<tid>/comm - hunting frida thread names such as gum-js-loop or gmain',
    steps: [{ syscalls: ['openat', 'newfstatat'], field: 'string_args', op: 'path_matches',
      value: '/proc/(self|[0-9]+)/task/[0-9]+/comm$' }] },
  { id: 'hook-fd-enum', category: 'hook', confidence: 0.6, mode: 'unordered',
    correlate: 'module+tid', maxGap: 50,
    rationale: 'opening /proc/<pid>/fd and walking it - looking for a debugger or agent file descriptor',
    steps: [
      { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '/proc/(self|[0-9]+)/fd$' },
      { syscalls: ['getdents64'], op: 'any' },
    ] },
  { id: 'hook-fd-readlink', category: 'hook', confidence: 0.6, minOccurrences: 50,
    rationale: 'sustained readlink of /proc/<pid>/fd/<n> - resolving every open descriptor, an agent/socket hunt',
    steps: [{ syscalls: ['readlinkat'], field: 'string_args', op: 'path_matches',
      value: '/proc/(self|[0-9]+)/fd/[0-9]+$' }] },
  { id: 'hook-xposed', category: 'hook', confidence: 0.9,
    rationale: 'probe for an Xposed/Riru/Zygisk/Substrate artefact, including the renamed app_process binaries',
    steps: [{ syscalls: ['openat', 'access', 'faccessat', 'newfstatat'], field: 'string_args', op: 'path_matches',
      value: 'app_process(32|64)?_original|app_process_init|/lib(64)?/libnb\\.so|xposed|riru|zygisk|substrate' }] },
  { id: 'hook-frida-scan', category: 'hook', confidence: 0.95, mode: 'unordered',
    correlate: 'module+tid', maxGap: 200,
    rationale: 'a maps/smaps walk and a frida artefact probe on one thread - a dynamic-instrumentation scan. Unordered: a real scan interleaves the two',
    steps: [
      { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '/proc/(self|[0-9]+)/s?maps$' },
      { syscalls: ['openat', 'newfstatat', 'faccessat', 'access', 'readlinkat'], field: 'string_args',
        op: 'path_matches', value: 'frida-(agent|gadget|server)|libfrida|re\\.frida|linjector|gum-js-loop' },
    ] },

  // -------------------------------------------------------------- emulator ---
  { id: 'emu-qemu-goldfish', category: 'emulator', confidence: 0.9,
    rationale: 'probe for a QEMU/goldfish/ranchu emulator artefact',
    steps: [{ syscalls: ['openat', 'access', 'faccessat', 'newfstatat', 'statfs'], field: 'string_args', op: 'path_matches',
      value: 'goldfish|ranchu|qemu[-_]|/dev/socket/qemud|/dev/qemu_' }] },
  { id: 'emu-vendor-images', category: 'emulator', confidence: 0.9,
    rationale: 'probe for a vendor emulator image (Nox, Genymotion, BlueStacks, LDPlayer, Droid4X, VirtualBox). Tokens are anchored: bare "memu" and "andy" substring-match ordinary paths',
    steps: [{ syscalls: ['openat', 'access', 'faccessat', 'newfstatat', 'statfs'], field: 'string_args', op: 'path_matches',
      value: 'genymotion|bluestacks|/bin/nox|noxsu|noxd$|nox-vbox|libnoxspeedup|vbox86|droid4x|ldplayer|/etc/init\\.nox' }] },
  { id: 'emu-hwinfo', category: 'emulator', confidence: 0.35, minOccurrences: 2,
    rationale: 'read of /proc/cpuinfo, /proc/version or /proc/meminfo - hardware fingerprinting. Weak: ordinary code reads these too',
    steps: [{ syscalls: ['openat', 'newfstatat', 'faccessat'], field: 'string_args', op: 'path_matches',
      value: '/proc/(cpuinfo|version|meminfo)$|/sys/module/intel_powerclamp|/sys/devices/virtual$' }] },
  { id: 'emu-qemu-props', category: 'emulator', confidence: 0.7,
    rationale: 'read of a qemu system-property context - ro.kernel.qemu style emulator check (unfired on available captures)',
    steps: [{ syscalls: ['openat', 'faccessat', 'newfstatat'], field: 'string_args', op: 'path_matches',
      value: '/dev/__properties__/.*qemu' }] },

  // ------------------------------------------------------------- integrity ---
  { id: 'integ-self-mem-read', category: 'integrity', confidence: 0.85, minOccurrences: 50,
    rationale: 'sustained process_vm_readv - the app reads its own memory to checksum it against an expected image',
    steps: [{ syscalls: ['process_vm_readv'], op: 'any' }] },
  { id: 'integ-apk-self', category: 'integrity', confidence: 0.35, minOccurrences: 10,
    rationale: 'repeated stat/open of the app\'s own APK - signature or CRC verification. ART also loads the APK legitimately, hence the low confidence',
    steps: [{ syscalls: ['openat', 'newfstatat', 'faccessat', 'statfs'], field: 'string_args', op: 'path_matches',
      value: '/data/app/.*\\.apk$' }] },
  { id: 'integ-dex', category: 'integrity', confidence: 0.4, minOccurrences: 5,
    rationale: 'repeated stat/open of the app\'s own dex/odex/vdex - bytecode tamper check',
    steps: [{ syscalls: ['openat', 'newfstatat', 'faccessat'], field: 'string_args', op: 'path_matches',
      value: '/data/app/.*\\.(odex|vdex|dex)$' }] },

  // ---------------------------------------------------------------- custom ---
  { id: 'env-prop-sweep', category: 'custom', confidence: 0.3, minOccurrences: 100,
    rationale: 'a broad sweep of system-property contexts under /dev/__properties__ - environment fingerprinting. The SELinux context leaks the property group, not the name',
    steps: [{ syscalls: ['openat', 'faccessat', 'newfstatat'], field: 'string_args', op: 'path_matches',
      value: '/dev/__properties__/' }] },
]

export const BUILTIN_RULES: Rule[] = (() => {
  const { rules, errors } = coerceRules(BUILTIN_SPECS, 'builtin')
  if (errors.length > 0) throw new Error(`malformed built-in rule: ${errors.join('; ')}`)
  return rules
})()

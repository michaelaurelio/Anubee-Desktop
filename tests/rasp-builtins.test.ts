import { describe, it, expect } from 'vitest'
import { BUILTIN_RULES, matchSequences, type Rule } from '../src/shared/rasp-heuristics'
import type { SyscallEvent } from '../src/shared/events'

const APP = [{ frame: 0, addr: '0x1000', symbol: 'libc.so!f+0x8' },
             { frame: 1, addr: '0x2100', symbol: 'libsentinel.so!chk+0x10' }]

function ev(over: Partial<SyscallEvent>): SyscallEvent {
  return {
    type: 'syscall', id: 1, pid: 100, tid: 100, syscall_nr: 0, syscall: 'openat',
    args: [], retval: 0, string_args: {}, fd_args: {}, decoded_args: {}, backtrace: APP, ...over,
  } as SyscallEvent
}
const only = (id: string): Rule[] => BUILTIN_RULES.filter(r => r.id === id)
const fires = (id: string, e: SyscallEvent) => matchSequences(only(id), [e]).hits.length > 0

describe('the built-in library', () => {
  it('ships 30 rules covering every category', () => {
    expect(BUILTIN_RULES).toHaveLength(30)
    for (const c of ['root', 'debugger', 'hook', 'emulator', 'integrity']) {
      expect(BUILTIN_RULES.some(r => r.category === c), c).toBe(true)
    }
  })

  it('has no duplicate ids', () => {
    expect(new Set(BUILTIN_RULES.map(r => r.id)).size).toBe(BUILTIN_RULES.length)
  })

  it('no longer ships the dead dbg-status-read rule', () => {
    expect(BUILTIN_RULES.some(r => r.id === 'dbg-status-read')).toBe(false)
  })

  // The /proc/self anchoring bug: the real detector opens /proc/<pid>/status 105
  // times and /proc/self/status once, so the old rule recalled 1 of 106.
  it('dbg-tracerpid matches the numeric-pid form as well as self', () => {
    for (const p of ['/proc/self/status', '/proc/23723/status', '/proc/thread-self/status']) {
      expect(fires('dbg-tracerpid', ev({ string_args: { '1': p } })), p).toBe(true)
    }
  })

  it('hook-maps-open matches smaps and the numeric-pid form', () => {
    for (const p of ['/proc/self/maps', '/proc/8185/maps', '/proc/self/smaps', '/proc/8185/smaps']) {
      expect(fires('hook-maps-open', ev({ string_args: { '1': p } })), p).toBe(true)
    }
  })

  // Regression guard: an unanchored 'gadget' token scored 86 false positives on a
  // production capture - usb.gadget HALs and theme .mtz files.
  it('hook-frida-artefact does not match usb.gadget or theme gadgets', () => {
    for (const p of ['/system/lib64/android.hardware.usb.gadget-V1-ndk.so',
                     '/system/lib64/android.hardware.usb.gadget@1.0.so',
                     '/system/media/theme/default/gadgets/clock_classical.mtz']) {
      expect(fires('hook-frida-artefact', ev({ string_args: { '1': p } })), p).toBe(false)
    }
  })

  it('hook-frida-artefact matches real frida artefacts', () => {
    for (const p of ['/data/local/tmp/frida-agent-64.so', '/data/local/tmp/re.frida.server',
                     '/system/lib64/libfrida-gadget.so']) {
      expect(fires('hook-frida-artefact', ev({ string_args: { '1': p } })), p).toBe(true)
    }
  })

  // The real signal is bind, not connect: the app squats frida's port.
  it('hook-frida-port matches a bind on 27042', () => {
    expect(fires('hook-frida-port', ev({ syscall: 'bind', sock_addr: '[::ffff:127.0.0.1]:27042' }))).toBe(true)
    expect(fires('hook-frida-port', ev({ syscall: 'connect', sock_addr: '[::ffff:127.0.0.1]:443' }))).toBe(false)
  })

  it('hook-frida-port-taken fires only on EADDRINUSE', () => {
    const at = (retval: number) => ev({ syscall: 'bind', sock_addr: '[::ffff:127.0.0.1]:27042', retval })
    expect(fires('hook-frida-port-taken', at(-98))).toBe(true)
    expect(fires('hook-frida-port-taken', at(0))).toBe(false)
  })

  // root-found must not fire on a stock directory: /system/xbin exists everywhere
  // and returning 0 for it produced 5 false positives on a clean device.
  it('root-found ignores the bare /system/xbin directory', () => {
    expect(fires('root-found', ev({ syscall: 'faccessat', string_args: { '1': '/system/xbin' }, retval: 0 }))).toBe(false)
    expect(fires('root-found', ev({ syscall: 'faccessat', string_args: { '1': '/system/xbin/su' }, retval: 0 }))).toBe(true)
    expect(fires('root-found', ev({ syscall: 'faccessat', string_args: { '1': '/system/xbin/su' }, retval: -2 }))).toBe(false)
  })

  it('emulator rules match qemu, goldfish, nox and genymotion artefacts', () => {
    const cases: [string, string][] = [
      ['emu-qemu-goldfish', '/dev/goldfish_sync'],
      ['emu-qemu-goldfish', '/system/vendor/bin/qemu-props'],
      ['emu-vendor-images', '/system/xbin/noxsu'],
      ['emu-vendor-images', '/system/etc/init.nox.sh'],
      ['emu-vendor-images', '/dev/com.genymotion.superuser.daemon'],
    ]
    for (const [id, p] of cases) expect(fires(id, ev({ string_args: { '1': p } })), `${id} ${p}`).toBe(true)
  })

  it('integ-self-mem-read matches any process_vm_readv', () => {
    expect(fires('integ-self-mem-read', ev({ syscall: 'process_vm_readv' }))).toBe(true)
  })

  it('dbg-ptrace-selftrace matches CONT, ATTACH and DETACH', () => {
    for (const a of ['0x7', '0x10', '0x11']) {
      expect(fires('dbg-ptrace-selftrace', ev({ syscall: 'ptrace', args: [a] })), a).toBe(true)
    }
    expect(fires('dbg-ptrace-selftrace', ev({ syscall: 'ptrace', args: ['0x0'] }))).toBe(false)
  })

  it('dbg-prctl-antidebug matches decoded PR_SET_DUMPABLE', () => {
    expect(fires('dbg-prctl-antidebug', ev({ syscall: 'prctl', decoded_args: { '0': 'PR_SET_DUMPABLE' } }))).toBe(true)
  })
})

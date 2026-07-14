import { describe, it, expect } from 'vitest'
import { eventDetailSections, appFrameIndex } from '../src/renderer/inspector'
import type { SyscallEvent } from '@shared/events'

const ev = (over: Partial<SyscallEvent> = {}): SyscallEvent => ({
  type: 'syscall', id: 1, pid: 1, tid: 23777, syscall_nr: 56, syscall: 'openat',
  args: [], retval: -13, string_args: {}, fd_args: {}, decoded_args: {},
  java_stack: [], backtrace: [], ...over,
})

describe('eventDetailSections', () => {
  it('always has a Summary kv section with syscall/nr/tid/retval', () => {
    const secs = eventDetailSections(ev())
    const sum = secs.find(s => s.title === 'Summary')
    expect(sum?.kind).toBe('kv')
    expect(sum).toMatchObject({ kind: 'kv' })
    if (sum?.kind === 'kv') {
      expect(sum.rows).toContainEqual(['syscall', 'openat (nr 56)'])
      expect(sum.rows).toContainEqual(['tid', '23777'])
      expect(sum.rows).toContainEqual(['retval', '-13'])
    }
  })
  it('skips an empty Args section and includes a non-empty one', () => {
    expect(eventDetailSections(ev()).some(s => s.title === 'Args')).toBe(false)
    const secs = eventDetailSections(ev({ string_args: { '1': '/x' } }))
    const args = secs.find(s => s.title === 'Args')
    expect(args?.kind).toBe('kv')
  })
  it('emits Java stack and Backtrace as stack sections when present', () => {
    const secs = eventDetailSections(ev({
      java_stack: ['com.example.A.b'],
      backtrace: [
        { frame: 0, addr: '0x1', symbol: 'libc.so!__openat+0x8' },
        { frame: 1, addr: '0x2', symbol: 'libexample.so!f+0x8' },
      ],
    }))
    const j = secs.find(s => s.title === 'Java stack')
    const b = secs.find(s => s.title === 'Backtrace')
    // Java stack has no app-frame concept - it should not carry a highlight field.
    expect(j).toMatchObject({ kind: 'stack', lines: ['com.example.A.b'] })
    expect((j as { highlight?: number })?.highlight).toBeUndefined()
    expect(b?.kind).toBe('stack')
    if (b?.kind === 'stack') {
      expect(b.lines[0]).toBe('#0 libc.so!__openat+0x8')
      // frame 1 (libexample.so) is the innermost non-system-lib frame.
      expect(b.highlight).toBe(1)
    }
  })
})

describe('appFrameIndex', () => {
  const S = (s: string) => ({ symbol: s })
  it('picks the innermost non-system frame', () => {
    expect(appFrameIndex([S('libc.so!__openat'), S('libselinux.so!x'), S('libstagefright.so+0x209028'), S('boot.oat!art_jni_trampoline')])).toBe(2)
  })
  it('returns -1 when every frame is a system lib', () => {
    expect(appFrameIndex([S('libc.so!read'), S('libart.so!x'), S('boot.oat!y')])).toBe(-1)
  })
})

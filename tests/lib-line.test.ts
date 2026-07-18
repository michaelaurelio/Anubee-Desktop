import { describe, it, expect } from 'vitest'
import { parseLibLine } from '@shared/lib-line'

describe('parseLibLine', () => {
  it('parses a full [lib] line', () => {
    const l = parseLibLine('[lib] pid 7420 /data/app/~~x/dev.anubee.detector-1/lib/arm64/libsentinel.so [0x7c40e10000, 0x7c40ee0000) off=0x0 inode=12345 ppid=1')
    expect(l).toEqual({
      kind: 'lib', pid: 7420,
      library: '/data/app/~~x/dev.anubee.detector-1/lib/arm64/libsentinel.so',
      start: '0x7c40e10000', end: '0x7c40ee0000', pgoff: 0, inode: 12345, ppid: 1,
    })
  })

  it('parses the optional -> soname suffix', () => {
    const l = parseLibLine('[lib] pid 10 /data/app/base.apk [0x1000, 0x2000) off=0x0 inode=5 ppid=2 -> libsentinel.so')
    expect(l?.soname).toBe('libsentinel.so')
    expect(l?.library).toBe('/data/app/base.apk')
  })

  it('parses an [unlib] line', () => {
    const l = parseLibLine('[unlib] pid 7420 [0x7b40000000, 0x7b40010000)')
    expect(l).toEqual({ kind: 'unlib', pid: 7420, start: '0x7b40000000', end: '0x7b40010000' })
  })

  it('returns null for unrelated stdout', () => {
    expect(parseLibLine('libbpf: loading object')).toBeNull()
    expect(parseLibLine('')).toBeNull()
  })

  it('parses a timestamped [lib] line identically to its un-timestamped twin', () => {
    const untimestamped = parseLibLine('[lib] pid 7420 /data/app/~~x/dev.anubee.detector-1/lib/arm64/libsentinel.so [0x7c40e10000, 0x7c40ee0000) off=0x0 inode=12345 ppid=1')
    const timestamped = parseLibLine('00:11:39 [lib] pid 7420 /data/app/~~x/dev.anubee.detector-1/lib/arm64/libsentinel.so [0x7c40e10000, 0x7c40ee0000) off=0x0 inode=12345 ppid=1')
    expect(timestamped).toEqual(untimestamped)
    expect(timestamped).toEqual({
      kind: 'lib', pid: 7420,
      library: '/data/app/~~x/dev.anubee.detector-1/lib/arm64/libsentinel.so',
      start: '0x7c40e10000', end: '0x7c40ee0000', pgoff: 0, inode: 12345, ppid: 1,
    })
  })

  it('parses a timestamped [unlib] line', () => {
    const l = parseLibLine('00:11:39 [unlib] pid 7420 [0x7b40000000, 0x7b40010000)')
    expect(l).toEqual({ kind: 'unlib', pid: 7420, start: '0x7b40000000', end: '0x7b40010000' })
  })

  it('parses a timestamped [lib] line with a -> soname suffix', () => {
    const l = parseLibLine('00:11:39 [lib] pid 10 /data/app/base.apk [0x1000, 0x2000) off=0x0 inode=5 ppid=2 -> libsentinel.so')
    expect(l?.soname).toBe('libsentinel.so')
    expect(l?.library).toBe('/data/app/base.apk')
  })

  it('parses a timestamped [lib] line with a bracketed pseudo-path library value', () => {
    const l = parseLibLine('00:11:39 [lib] pid 22538 [anon_shmem:dalvik-jit-code-cache] [0x48000000, 0x4a000000) off=0x2000 inode=3600126 ppid=959')
    expect(l?.library).toBe('[anon_shmem:dalvik-jit-code-cache]')
  })
})

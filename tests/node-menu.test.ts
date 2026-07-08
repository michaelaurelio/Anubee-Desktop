import { describe, it, expect } from 'vitest'
import { nodeCopyText } from '../src/renderer/node-menu'

describe('nodeCopyText', () => {
  it('strips the kind prefix to the bare identifier', () => {
    expect(nodeCopyText('nat:base.apk -> libsentinel.so!sentinel_check_root')).toBe('base.apk -> libsentinel.so!sentinel_check_root')
    expect(nodeCopyText('java:com.example.Sec.check')).toBe('com.example.Sec.check')
    expect(nodeCopyText('sys:openat')).toBe('openat')
  })
})

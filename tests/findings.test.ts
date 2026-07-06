import { describe, it, expect } from 'vitest'
import { buildFindings, renderMarkdown, renderJSON } from '../src/shared/findings'
import type { Tag } from '../src/shared/project-store'
import type { SyscallEvent } from '../src/shared/events'

const ev: SyscallEvent = {
  type: 'syscall', id: 1, pid: 100, tid: 101, syscall_nr: 56, syscall: 'openat',
  args: [], retval: 7, string_args: { '1': '/system/bin/su' }, fd_args: {}, decoded_args: {},
  java_stack: ['com.example.app.RootCheck.run'],
  backtrace: [{ frame: 0, addr: '0x1', symbol: 'libexample.so!check_su+0x10' }],
}
const tag: Tag = { target: 'nat:libexample.so!check_su', category: 'root',
  source: 'heuristic', createdAt: 'T', note: 'confirmed' }

describe('findings', () => {
  it('builds a finding joining tag + representative event', () => {
    const f = buildFindings([tag], { 'nat:libexample.so!check_su': [ev, ev] })
    expect(f).toEqual([{
      target: 'nat:libexample.so!check_su', category: 'root',
      javaCaller: 'com.example.app.RootCheck.run', syscall: 'openat',
      hitPath: '/system/bin/su', occurrences: 2, note: 'confirmed',
    }])
  })

  it('handles a tag with no representative events', () => {
    const f = buildFindings([tag], {})
    expect(f[0]).toMatchObject({ javaCaller: null, syscall: null, hitPath: null, occurrences: 0 })
  })

  it('renders markdown citing block, category, caller, and hit', () => {
    const md = renderMarkdown(buildFindings([tag], { 'nat:libexample.so!check_su': [ev] }))
    expect(md).toContain('root')
    expect(md).toContain('libexample.so!check_su')
    expect(md).toContain('com.example.app.RootCheck.run')
    expect(md).toContain('/system/bin/su')
  })

  it('markdown uses the offset as the block label when a tag has an offset', () => {
    const offsetTag: Tag = { ...tag, offset: 'libexample.so+0x1234' }
    const md = renderMarkdown(buildFindings([offsetTag], { 'nat:libexample.so!check_su': [ev] }))
    expect(md).toContain('libexample.so+0x1234')
  })

  it('renders valid JSON', () => {
    const json = renderJSON(buildFindings([tag], { 'nat:libexample.so!check_su': [ev] }))
    expect(JSON.parse(json)).toHaveLength(1)
  })

  it('renders an empty-but-valid report with no tags', () => {
    expect(JSON.parse(renderJSON([]))).toEqual([])
    expect(renderMarkdown([])).toContain('No findings')
  })
})

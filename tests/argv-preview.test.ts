// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderArgvPreview } from '../src/renderer/argv-preview'

const ARGV = "su -c '/data/local/tmp/anubee syscalls -P dev.anubee.detector -l libsentinel.so -o /data/local/tmp/x.jsonl'"

describe('renderArgvPreview', () => {
  it('renders the argv verbatim as text', () => {
    const host = document.createElement('div')
    renderArgvPreview(host, ARGV)
    // Preview and dispatch must never diverge - assert character equality.
    expect(host.textContent).toBe(ARGV)
  })

  it('accents the engine invocation and highlights values', () => {
    const host = document.createElement('div')
    renderArgvPreview(host, ARGV)
    expect(host.querySelector('.argv-bin')!.textContent).toBe('/data/local/tmp/anubee syscalls')
    const vals = [...host.querySelectorAll('.argv-val')].map(e => e.textContent)
    expect(vals).toContain('dev.anubee.detector')
    expect(vals).toContain('libsentinel.so')
  })

  it('replaces prior content on re-render', () => {
    const host = document.createElement('div')
    renderArgvPreview(host, ARGV)
    renderArgvPreview(host, 'su -c \'/data/local/tmp/anubee funcs -P p\'')
    expect(host.textContent).toBe('su -c \'/data/local/tmp/anubee funcs -P p\'')
    expect(host.querySelectorAll('.argv-bin')).toHaveLength(1)
  })

  it('survives an argv with no recognisable engine', () => {
    const host = document.createElement('div')
    renderArgvPreview(host, 'nonsense')
    expect(host.textContent).toBe('nonsense')
  })

  it('leaves the su -c quotes outside the highlighted spans', () => {
    const host = document.createElement('div')
    renderArgvPreview(host, ARGV)
    // The quotes are wrapper punctuation, not part of the command or a value.
    expect(host.querySelector('.argv-bin')!.textContent!.startsWith("'")).toBe(false)
    for (const v of host.querySelectorAll('.argv-val')) {
      expect(v.textContent!.endsWith("'")).toBe(false)
    }
  })
})

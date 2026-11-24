// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderMcpPanel, mcpLogLine } from '../src/renderer/mcp-view'
import type { McpState } from '../src/main/mcp-control'

const noop = { toggle() {}, revoke() {} }
const base: McpState = { on: false, attached: false, granted: false, log: [] }

describe('mcp-view', () => {
  it('reflects the on state on the toggle', () => {
    const host = document.createElement('div')
    renderMcpPanel(host, { ...base, on: true }, noop)
    expect(host.querySelector('[data-mcp-toggle]')!.getAttribute('aria-checked')).toBe('true')
    renderMcpPanel(host, base, noop)
    expect(host.querySelector('[data-mcp-toggle]')!.getAttribute('aria-checked')).toBe('false')
  })

  it('shows Revoke only when granted, and wires actions', () => {
    const host = document.createElement('div')
    const actions = { toggle: vi.fn(), revoke: vi.fn() }
    renderMcpPanel(host, base, actions)
    expect(host.querySelector('[data-mcp-revoke]')).toBeNull()
    renderMcpPanel(host, { ...base, on: true, granted: true }, actions)
    ;(host.querySelector('[data-mcp-revoke]') as HTMLElement).click()
    expect(actions.revoke).toHaveBeenCalled()
    ;(host.querySelector('[data-mcp-toggle]') as HTMLElement).click()
    expect(actions.toggle).toHaveBeenCalledWith(false)
  })

  it('renders log args as inert text', () => {
    const host = document.createElement('div')
    const args = '<img src=x onerror=alert(1)>'
    renderMcpPanel(host, { ...base, on: true, log: [{ at: 1, tool: 'tag', args, result: 'ok' }] }, noop)
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain(args)
    expect(mcpLogLine({ at: 1, tool: 't', args, result: 'error', detail: '<b>x</b>' }).querySelector('b')).toBeNull()
  })
})

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { grantChoiceOf, requestDeviceGrant } from '../src/renderer/mcp-grant'
import { closeModal } from '../src/renderer/modal'
import { createDeviceGate } from '../src/main/mcp-device-gate'
import { isDeviceGranted, resetMcpState } from '../src/main/mcp-log'

beforeEach(() => resetMcpState())
afterEach(() => closeModal())

describe('grantChoiceOf', () => {
  it('maps each button to its choice', () => {
    expect(grantChoiceOf('allow-once')).toBe('once')
    expect(grantChoiceOf('allow-session')).toBe('session')
    expect(grantChoiceOf('deny')).toBe('deny')
  })
})

describe('requestDeviceGrant modal', () => {
  it('renders the action inertly and resolves with the clicked choice', async () => {
    const p = requestDeviceGrant('<img src=x onerror=1>dump')
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('.modal-body')?.textContent).toContain('<img src=x onerror=1>dump')
    document.querySelector<HTMLButtonElement>('[data-grant="allow-session"]')!.click()
    expect(await p).toBe('session')
  })
  it('resolves deny when dismissed', async () => {
    const p = requestDeviceGrant('capture')
    closeModal()
    expect(await p).toBe('deny')
  })
})

describe('main-side device gate', () => {
  const mk = (reply: unknown) => createDeviceGate({
    ask: async () => { if (reply instanceof Error) throw reply; return reply as never },
  })
  it("'session' grants and allows", async () => {
    expect(await mk('session')('dump')).toBe(true)
    expect(isDeviceGranted()).toBe(true)
  })
  it("'once' allows without granting", async () => {
    expect(await mk('once')('dump')).toBe(true)
    expect(isDeviceGranted()).toBe(false)
  })
  it("'deny', garbage, and errors fail closed", async () => {
    expect(await mk('deny')('dump')).toBe(false)
    expect(await mk('yes please')('dump')).toBe(false)
    expect(await mk(new Error('no window'))('dump')).toBe(false)
    expect(isDeviceGranted()).toBe(false)
  })
})

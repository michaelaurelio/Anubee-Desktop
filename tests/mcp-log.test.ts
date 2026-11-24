import { describe, it, expect } from 'vitest'
import {
  appendMcpLog, getMcpLog, resetMcpState,
  grantDeviceForSession, revokeDeviceGrant, isDeviceGranted,
} from '../src/main/mcp-log'

describe('mcp-log', () => {
  it('ring-caps the log and toggles the device grant', () => {
    resetMcpState()
    for (let i = 0; i < 2100; i++) appendMcpLog({ at: i, tool: 't', args: '', result: 'ok' })
    expect(getMcpLog().length).toBe(2000)
    expect(getMcpLog()[0].at).toBe(100) // oldest 100 dropped
    expect(isDeviceGranted()).toBe(false)
    grantDeviceForSession(); expect(isDeviceGranted()).toBe(true)
    revokeDeviceGrant(); expect(isDeviceGranted()).toBe(false)
  })
})

// Main-side mapping of the renderer's grant reply to the control server's
// deviceGate result. Fails closed: anything but an explicit once/session is a deny.
import { grantDeviceForSession } from './mcp-log'

export type GrantReply = 'once' | 'session' | 'deny'

export function createDeviceGate(deps: { ask: (action: string) => Promise<GrantReply> }) {
  return async (action: string): Promise<boolean> => {
    try {
      const reply = await deps.ask(action)
      if (reply === 'session') { grantDeviceForSession(); return true }
      return reply === 'once'
    } catch {
      return false
    }
  }
}

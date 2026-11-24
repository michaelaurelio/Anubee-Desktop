// Per-action device-grant prompt: an MCP client asked to run a Tier-3 device
// action (capture/dump/live-libs) that is not yet granted for this session.
import { showModal, closeModal } from './modal'

export type GrantChoice = 'once' | 'session' | 'deny'
export type GrantButton = 'allow-once' | 'allow-session' | 'deny'

export function grantChoiceOf(button: GrantButton): GrantChoice {
  switch (button) {
    case 'allow-once': return 'once'
    case 'allow-session': return 'session'
    default: return 'deny'
  }
}

export function requestDeviceGrant(action: string): Promise<GrantChoice> {
  return new Promise<GrantChoice>(resolve => {
    let settled = false
    const settle = (c: GrantChoice): void => { if (!settled) { settled = true; resolve(c) } }
    showModal({
      title: 'MCP device action',
      width: 460,
      // Dismiss (x / Esc / backdrop / replaced by another modal) is a denial.
      onClose: () => settle('deny'),
      render: host => {
        const msg = document.createElement('p')
        msg.append('An MCP client wants to run a device action: ')
        const name = document.createElement('code')
        name.textContent = action // inert: command name from an external client
        msg.append(name, '. It will touch the connected device.')
        const row = document.createElement('div')
        row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px'
        const mk = (label: string, button: GrantButton): void => {
          const b = document.createElement('button')
          b.className = 'btn'
          b.textContent = label
          b.dataset.grant = button
          b.onclick = () => { settle(grantChoiceOf(button)); closeModal() }
          row.appendChild(b)
        }
        mk('Deny', 'deny')
        mk('Allow once', 'allow-once')
        mk('Allow for this session', 'allow-session')
        host.append(msg, row)
      },
    })
  })
}

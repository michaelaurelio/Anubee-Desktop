import type { McpState } from '../main/mcp-control'
import type { McpLogEntry } from '../main/mcp-log'

export interface McpActions {
  toggle(on: boolean): void
  revoke(): void
}

function hhmmss(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// One audit row. Tool args are untrusted (they come from an external AI
// client), so everything here goes through textContent - never innerHTML.
export function mcpLogLine(e: McpLogEntry): HTMLElement {
  const div = document.createElement('div')
  div.className = `log-line mcp-log-line${e.result === 'error' ? ' log-error' : ''}`
  const detail = e.detail ? ` - ${e.detail}` : ''
  div.textContent = `${hhmmss(e.at)} ${e.tool} ${e.args} -> ${e.result}${detail}`
  return div
}

function statusText(s: McpState): string {
  if (!s.on) return 'Control server is off'
  const conn = s.attached ? 'AI client connected' : 'Waiting for an AI client'
  return `${conn} - device actions ${s.granted ? 'granted' : 'not granted'}`
}

// Pure render: rebuilds the whole panel from `state`. Safe to call repeatedly
// (live log / state pushes just re-render).
export function renderMcpPanel(host: HTMLElement, state: McpState, actions: McpActions): void {
  host.innerHTML = ''

  const head = document.createElement('div')
  head.className = 'mcp-head'
  const label = document.createElement('span')
  label.textContent = 'Allow AI control (MCP)'
  const toggle = document.createElement('button')
  toggle.className = 'btn mcp-toggle'
  toggle.setAttribute('data-mcp-toggle', '')
  toggle.setAttribute('role', 'switch')
  toggle.setAttribute('aria-checked', String(state.on))
  toggle.textContent = state.on ? 'On' : 'Off'
  toggle.onclick = () => actions.toggle(!state.on)
  head.append(label, toggle)

  const status = document.createElement('div')
  status.className = 'mcp-status'
  const st = document.createElement('span')
  st.textContent = statusText(state)
  status.appendChild(st)
  if (state.granted) {
    const revoke = document.createElement('button')
    revoke.className = 'btn mcp-revoke'
    revoke.setAttribute('data-mcp-revoke', '')
    revoke.textContent = 'Revoke'
    revoke.onclick = () => actions.revoke()
    status.appendChild(revoke)
  }

  const term = document.createElement('div')
  term.className = 'log-term'
  if (state.log.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'log-empty'
    empty.textContent = 'No AI actions yet'
    term.appendChild(empty)
  } else {
    for (const e of state.log) term.appendChild(mcpLogLine(e))
  }

  host.append(head, status, term)
  term.scrollTop = term.scrollHeight
}

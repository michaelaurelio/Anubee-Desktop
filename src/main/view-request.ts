// Main-side round-trip for the MCP view snapshot: send mcp:viewRequest {id},
// the renderer answers on mcp:viewReply {id, view}. Correlated by id, so
// concurrent requests never cross. Electron-free; index.ts injects `send`.
import { randomUUID } from 'node:crypto'
import { VIEW_TIMEOUT_MS, type RendererView } from '@shared/view-snapshot'

export interface ViewRequester {
  request(): Promise<RendererView>
  reply(m: unknown): void
}

interface Pending {
  resolve: (v: RendererView) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function createViewRequester(deps: {
  send: (id: string) => boolean
  timeoutMs?: number
  newId?: () => string
}): ViewRequester {
  const pending = new Map<string, Pending>()
  const timeoutMs = deps.timeoutMs ?? VIEW_TIMEOUT_MS
  const newId = deps.newId ?? randomUUID

  const take = (id: string): Pending | undefined => {
    const p = pending.get(id)
    if (p) { clearTimeout(p.timer); pending.delete(id) }
    return p
  }

  return {
    request() {
      return new Promise<RendererView>((resolve, reject) => {
        const id = newId()
        const timer = setTimeout(() => {
          take(id)?.reject(new Error('Anubee window did not answer the view request'))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        let sent = false
        try { sent = deps.send(id) } catch { sent = false }
        if (!sent) take(id)?.reject(new Error('Anubee window not available'))
      })
    },
    reply(m) {
      if (typeof m !== 'object' || m === null) return
      const { id, view } = m as { id?: unknown; view?: unknown }
      if (typeof id !== 'string') return
      const p = take(id)
      if (!p) return // unknown or already timed out
      if (typeof view !== 'object' || view === null) p.reject(new Error('malformed view reply'))
      else p.resolve(view as RendererView)
    },
  }
}

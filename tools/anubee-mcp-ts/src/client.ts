export interface Conn {
  baseUrl: string
  token: string
}

export async function call<T>(conn: Conn, command: string, args?: unknown): Promise<T> {
  const res = await fetch(`${conn.baseUrl}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-anubee-token': conn.token },
    body: JSON.stringify({ command, args }),
  })
  const body = (await res.json()) as { ok: boolean; result?: T; error?: string }
  if (!body.ok) throw new Error(body.error ?? `call ${command} failed (${res.status})`)
  return body.result as T
}

export function openStream(
  conn: Conn,
  name: string,
  onEvent: (data: unknown) => void,
): () => void {
  const ac = new AbortController()
  void (async () => {
    try {
      const res = await fetch(`${conn.baseUrl}/stream/${encodeURIComponent(name)}`, {
        headers: { 'x-anubee-token': conn.token, accept: 'text/event-stream' },
        signal: ac.signal,
      })
      if (!res.ok || !res.body) return
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '')
          buf = buf.slice(i + 1)
          if (!line.startsWith('data:')) continue
          try {
            onEvent(JSON.parse(line.slice(5).trim()))
          } catch {
            /* ignore malformed event */
          }
        }
      }
    } catch {
      /* aborted or connection closed */
    }
  })()
  return () => ac.abort()
}

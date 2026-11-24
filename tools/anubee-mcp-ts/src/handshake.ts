import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Local copy of the Desktop handshake shape (kept electron-free on purpose).
export interface Handshake {
  port: number
  token: string
  pid: number
  startedAt: number
}

const APP_NAME = 'anubee-desktop'

export function userDataDir(): string {
  const override = process.env.ANUBEE_DESKTOP_USERDATA
  if (override) return override
  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', APP_NAME)
    case 'win32':
      return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), APP_NAME)
    default:
      return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), APP_NAME)
  }
}

function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function resolveApp(): { baseUrl: string; token: string } {
  const fail = (): never => {
    throw new Error('no running Anubee Desktop with MCP control enabled')
  }
  let hs: Handshake
  try {
    hs = JSON.parse(readFileSync(join(userDataDir(), 'mcp-control.json'), 'utf8')) as Handshake
  } catch {
    return fail()
  }
  if (
    !hs ||
    typeof hs.port !== 'number' ||
    typeof hs.token !== 'string' ||
    typeof hs.pid !== 'number' ||
    !isLive(hs.pid)
  ) {
    return fail()
  }
  return { baseUrl: `http://127.0.0.1:${hs.port}`, token: hs.token }
}

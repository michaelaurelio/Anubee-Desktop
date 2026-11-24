import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Handshake {
  port: number
  token: string
  pid: number
  startedAt: number
}

export function handshakePath(userDataDir: string): string {
  return join(userDataDir, 'mcp-control.json')
}

export function writeHandshake(userDataDir: string, hs: Handshake): void {
  const path = handshakePath(userDataDir)
  writeFileSync(path, JSON.stringify(hs), { mode: 0o600 })
  // mode above is masked by umask and ignored when the file already exists
  chmodSync(path, 0o600)
}

export function readHandshake(userDataDir: string): Handshake | null {
  try {
    const raw = JSON.parse(readFileSync(handshakePath(userDataDir), 'utf8'))
    if (
      raw &&
      typeof raw.port === 'number' &&
      typeof raw.token === 'string' &&
      typeof raw.pid === 'number' &&
      typeof raw.startedAt === 'number'
    ) {
      return { port: raw.port, token: raw.token, pid: raw.pid, startedAt: raw.startedAt }
    }
    return null
  } catch {
    return null
  }
}

export function removeHandshake(userDataDir: string): void {
  rmSync(handshakePath(userDataDir), { force: true })
}

export function isHandshakeLive(hs: Handshake): boolean {
  try {
    process.kill(hs.pid, 0)
    return true
  } catch (err) {
    // EPERM: process exists but is not ours to signal. ESRCH/other: not live.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

import { logAppend, type LogLevel } from './log-store'

// Wrap a user action: log a formatted success entry on resolve (skip if the
// formatter returns null), log an error entry and rethrow on rejection.
export async function runLogged<T>(
  label: string,
  fn: () => Promise<T>,
  formatSuccess: (r: T) => { level: LogLevel; message: string } | null,
): Promise<T> {
  try {
    const r = await fn()
    const s = formatSuccess(r)
    if (s) logAppend(s.level, label, s.message)
    return r
  } catch (e) {
    logAppend('error', label, e instanceof Error ? e.message : String(e))
    throw e
  }
}

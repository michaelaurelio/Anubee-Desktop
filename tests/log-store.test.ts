import { describe, it, expect, beforeEach } from 'vitest'
import { logAppend, logGetAll, logClear, logSubscribe, formatLog, LOG_CAP } from '../src/renderer/log-store'

beforeEach(() => logClear())

describe('log-store', () => {
  it('appends entries with a timestamp and returns the entry', () => {
    const e = logAppend('success', 'load', 'Loaded 5 events')
    expect(e.level).toBe('success')
    expect(e.label).toBe('load')
    expect(e.message).toBe('Loaded 5 events')
    expect(typeof e.ts).toBe('number')
    expect(logGetAll()).toHaveLength(1)
  })

  it('caps the buffer, dropping oldest', () => {
    for (let i = 0; i < LOG_CAP + 10; i++) logAppend('info', 'x', String(i))
    const all = logGetAll()
    expect(all).toHaveLength(LOG_CAP)
    expect(all[0].message).toBe('10') // first 10 dropped
    expect(all[all.length - 1].message).toBe(String(LOG_CAP + 9))
  })

  it('notifies subscribers per entry until unsubscribed', () => {
    const seen: string[] = []
    const unsub = logSubscribe(e => seen.push(e.message))
    logAppend('info', 'a', 'one')
    unsub()
    logAppend('info', 'a', 'two')
    expect(seen).toEqual(['one'])
  })

  it('clears the buffer', () => {
    logAppend('info', 'a', 'x')
    logClear()
    expect(logGetAll()).toHaveLength(0)
  })

  it('notifies subscribers on clear with a sentinel empty-label entry (modal redraw hook)', () => {
    const seen: { label: string; message: string }[] = []
    logAppend('info', 'a', 'x')
    const unsub = logSubscribe(e => seen.push({ label: e.label, message: e.message }))
    logClear()
    unsub()
    expect(seen).toEqual([{ label: '', message: '' }])
  })

  it('formatLog renders one padded line per entry', () => {
    const line = formatLog([{ ts: 0, level: 'error', label: 'export', message: 'boom' }])
    expect(line).toMatch(/\[ERROR\]\s+export: boom$/)
  })
})

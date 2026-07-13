// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { clampColWidth, nextWidth, applyWidths } from '../src/renderer/column-resize'

describe('clampColWidth', () => {
  it('clamps below the floor', () => { expect(clampColWidth(10)).toBe(48) })
  it('clamps above the ceiling', () => { expect(clampColWidth(9999)).toBe(640) })
  it('passes a value in range', () => { expect(clampColWidth(200)).toBe(200) })
})

describe('nextWidth', () => {
  it('adds the drag delta, clamped', () => {
    expect(nextWidth(100, 40)).toBe(140)
    expect(nextWidth(100, -900)).toBe(48)
  })
})

describe('applyWidths', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="host"><table><thead><tr><th class="col-callSite"></th></tr></thead><tbody><tr><td class="col-callSite"></td></tr></tbody></table></div>'
  })

  it('applies clamped widths to both header and cell elements with matching class', () => {
    const host = document.querySelector<HTMLElement>('#host')!
    applyWidths(host, { callSite: 300 })
    const th = document.querySelector<HTMLElement>('.col-callSite')
    const td = document.querySelector<HTMLElement>('td.col-callSite')
    expect(th?.style.width).toBe('300px')
    expect(td?.style.width).toBe('300px')
  })
})

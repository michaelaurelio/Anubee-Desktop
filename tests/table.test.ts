// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { renderTable } from '../src/renderer/table'
import type { TableRow } from '@shared/table'

const row: TableRow = {
  id: 9, tid: 237, syscall: 'faccessat', retval: -2, hasJava: true,
  topJava: 'FileCheck.exists', topNative: 'libsentinel.so!chk+0x40', arg: '/data/app/base.apk',
}

beforeEach(() => {
  document.body.innerHTML = '<div id="table"><div class="table-scroll"></div></div>'
})

describe('renderTable', () => {
  it('renders exactly the requested columns in order', () => {
    renderTable([row], ['id', 'syscall', 'arg'], () => {})
    const heads = [...document.querySelectorAll('#table th')].map(th => th.textContent)
    expect(heads).toEqual(['id', 'syscall', 'args'])
  })

  it('args + tags cells render, and each row carries data-row-id', () => {
    renderTable([row], ['arg', 'tags'], () => {}, () => 'RASP')
    const tds = [...document.querySelectorAll('#table td')].map(td => td.textContent)
    expect(tds).toEqual(['/data/app/base.apk', 'RASP'])
    expect(document.querySelector('#table tr[data-row-id="9"]')).not.toBeNull()
  })

  it('invokes onSelect with the row on click', () => {
    let picked: TableRow | undefined
    renderTable([row], ['id'], r => { picked = r })
    document.querySelector<HTMLElement>('#table tr[data-row-id="9"]')!.click()
    expect(picked?.id).toBe(9)
  })
})

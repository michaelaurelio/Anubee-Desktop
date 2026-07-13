// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { renderTable } from '../src/renderer/table'
import { javaLeaf } from '../src/renderer/call-site'
import type { TableRow } from '@shared/table'

const row: TableRow = {
  id: 9, tid: 237, engine: 'syscall', syscall: 'faccessat', retval: -2, hasJava: true,
  topJava: 'FileCheck.exists', topNative: 'libsentinel.so!chk+0x40', arg: '/data/app/base.apk',
}

const funcRow: TableRow = {
  id: 41, tid: 23, engine: 'func', syscall: '', retval: -1, hasJava: false,
  topJava: null, topNative: null, arg: '-', fn: 'libsentinel.so!mapsScan',
  caller: 'libsentinel.so!checkRoot+0x8', elapsed: 5400,
}
const nativeOnly: TableRow = {
  id: 2, tid: 9, engine: 'syscall', syscall: 'read', retval: 0, hasJava: false,
  topJava: null, topNative: 'libc.so!read+0x8', arg: 'fd=3',
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

describe('call-site cell', () => {
  it('syscall paired row shows java leaf over native leaf', () => {
    renderTable([row], ['callSite'], () => {})
    const cell = document.querySelector('#table td.col-callSite')!
    expect(cell.querySelector('.cs-java')?.textContent).toBe('exists')            // javaLeaf('FileCheck.exists')
    expect(cell.querySelector('.cs-native')?.textContent).toBe('libsentinel.so!chk') // nativeLeaf strips +0x40
    expect(cell.classList.contains('paired')).toBe(true)
  })
  it('native-only row shows a single native line, not paired', () => {
    renderTable([nativeOnly], ['callSite'], () => {})
    const cell = document.querySelector('#table td.col-callSite')!
    expect(cell.classList.contains('paired')).toBe(false)
    expect(cell.querySelector('.cs-native')?.textContent).toBe('libc.so!read')
    expect(cell.querySelector('.cs-java')).toBeNull()
  })
  it('no-backtrace row shows the empty marker', () => {
    const bare: TableRow = { ...nativeOnly, id: 3, topNative: null }
    renderTable([bare], ['callSite'], () => {})
    expect(document.querySelector('#table td.col-callSite .cs-none')?.textContent).toContain('no backtrace')
  })
  it('funcs row stacks function over caller', () => {
    renderTable([funcRow], ['callSite'], () => {})
    const cell = document.querySelector('#table td.col-callSite')!
    expect(cell.querySelector('.cs-fn')?.textContent).toBe('libsentinel.so!mapsScan')
    expect(cell.querySelector('.cs-caller')?.textContent).toBe('libsentinel.so!checkRoot')
  })
})

describe('funcs numeric cells', () => {
  it('negative retval gets the neg class', () => {
    renderTable([funcRow], ['retval'], () => {})
    expect(document.querySelector('#table td.col-retval .neg')).not.toBeNull()
  })
  it('unpaired call (null retval/elapsed) shows em-dash, no bar', () => {
    const unpaired: TableRow = { ...funcRow, id: 42, retval: null, elapsed: null }
    renderTable([unpaired], ['retval', 'elapsed'], () => {})
    expect(document.querySelector('#table td.col-elapsed .bar')).toBeNull()
    expect(document.querySelector('#table td.col-elapsed')?.textContent).toContain('—')
  })
  it('elapsed renders a bar scaled to elapsedMax', () => {
    renderTable([funcRow], ['elapsed'], () => {}, () => '', 5400)
    const bar = document.querySelector('#table td.col-elapsed .bar') as HTMLElement
    expect(bar.style.width).toBe('100%')
  })
})

describe('tag chips', () => {
  it('renders each tag as a chip element, not comma text', () => {
    renderTable([row], ['tags'], () => {}, () => 'root,hook')
    expect(document.querySelectorAll('#table td.col-tags .chip').length).toBe(2)
  })
})

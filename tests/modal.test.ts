// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { showModal, closeModal, isModalOpen } from '../src/renderer/modal'

afterEach(() => closeModal())

describe('modal', () => {
  it('opens with a title and renders content, then reports open', () => {
    showModal({ title: 'Rules', render: h => { h.textContent = 'body' } })
    expect(isModalOpen()).toBe(true)
    expect(document.querySelector('.modal-head')?.textContent).toContain('Rules')
    expect(document.querySelector('.modal-body')?.textContent).toBe('body')
  })
  it('closes on closeModal and fires onClose once', () => {
    let closed = 0
    showModal({ title: 'X', render: () => {}, onClose: () => { closed++ } })
    closeModal()
    expect(isModalOpen()).toBe(false)
    expect(document.querySelector('.modal-backdrop')).toBeNull()
    expect(closed).toBe(1)
  })
  it('opening a second modal closes the first', () => {
    let firstClosed = 0
    showModal({ title: 'A', render: () => {}, onClose: () => { firstClosed++ } })
    showModal({ title: 'B', render: () => {} })
    expect(firstClosed).toBe(1)
    expect(document.querySelectorAll('.modal-backdrop').length).toBe(1)
    expect(document.querySelector('.modal-head')?.textContent).toContain('B')
  })
})

// A single shared centered-modal overlay: dim backdrop + centered card with a
// title and close (x). Closes on x / Esc / backdrop-click. One modal at a time -
// opening a second closes the first (firing its onClose). Capture/Rules/
// Suggestions all open through this. See design s5.3.

let backdrop: HTMLDivElement | undefined
let onKey: ((e: KeyboardEvent) => void) | undefined
let closeCb: (() => void) | undefined

export function isModalOpen(): boolean {
  return backdrop !== undefined
}

export function closeModal(): void {
  if (!backdrop) return
  const cb = closeCb
  backdrop.remove(); backdrop = undefined
  if (onKey) { document.removeEventListener('keydown', onKey); onKey = undefined }
  closeCb = undefined
  cb?.()
}

interface ModalOpts {
  title: string
  render: (host: HTMLElement) => void
  width?: number
  onClose?: () => void
}

export function showModal(opts: ModalOpts): void {
  closeModal()
  closeCb = opts.onClose

  backdrop = document.createElement('div')
  backdrop.className = 'modal-backdrop'
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) closeModal() })

  const card = document.createElement('div')
  card.className = 'modal'
  if (opts.width) card.style.width = opts.width + 'px'

  const head = document.createElement('div')
  head.className = 'modal-head'
  const title = document.createElement('span')
  title.className = 'modal-title'; title.textContent = opts.title
  const x = document.createElement('button')
  x.className = 'modal-x'; x.textContent = '×'
  x.onclick = () => closeModal()
  head.append(title, x)

  const body = document.createElement('div')
  body.className = 'modal-body'
  opts.render(body)

  card.append(head, body)
  backdrop.appendChild(card)
  document.body.appendChild(backdrop)

  onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal() }
  document.addEventListener('keydown', onKey)
}

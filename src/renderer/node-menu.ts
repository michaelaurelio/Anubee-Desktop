// Right-click (cxttap) context menu for a graph node: Copy the node identifier,
// or Tag the node (opens the tag editor inline in the menu). A floating panel at
// the cursor, dismissed on outside-click / Esc. DOM side-effect, not unit-tested.

// Strip the kind prefix so the copied text is the bare identifier
// (module!symbol / java method / syscall name), pasteable into a filter or an
// external tool.
export function nodeCopyText(nodeId: string): string {
  return nodeId.replace(/^(nat:|java:|sys:)/, '')
}

let menu: HTMLDivElement | undefined
let onDoc: ((e: MouseEvent) => void) | undefined
let onKey: ((e: KeyboardEvent) => void) | undefined

export function closeNodeMenu(): void {
  menu?.remove(); menu = undefined
  if (onDoc) { document.removeEventListener('mousedown', onDoc); onDoc = undefined }
  if (onKey) { document.removeEventListener('keydown', onKey); onKey = undefined }
}

interface ShowOpts {
  nodeId: string
  anchor: { x: number; y: number }
  onCopy: (text: string) => void
  tagHost: (h: HTMLElement) => void
}

export function showNodeMenu(opts: ShowOpts): void {
  closeNodeMenu()
  menu = document.createElement('div')
  menu.className = 'node-menu'
  const x = Math.min(opts.anchor.x, window.innerWidth - 260)
  const y = Math.min(opts.anchor.y, window.innerHeight - 240)
  Object.assign(menu.style, { position: 'fixed', left: Math.max(8, x) + 'px', top: Math.max(8, y) + 'px', zIndex: '60' })

  const item = (text: string, fn: () => void) => {
    const b = document.createElement('div')
    b.className = 'node-menu-item'
    b.textContent = text
    b.onclick = fn
    menu!.appendChild(b)
  }
  item('Copy', () => { opts.onCopy(nodeCopyText(opts.nodeId)); closeNodeMenu() })
  item('Tag…', () => {
    // Swap the menu contents for the tag editor, keep the panel open.
    menu!.innerHTML = ''
    const box = document.createElement('div')
    box.className = 'node-menu-tag'
    opts.tagHost(box)
    menu!.appendChild(box)
  })

  document.body.appendChild(menu)
  setTimeout(() => {
    onDoc = (e: MouseEvent) => { if (menu && !menu.contains(e.target as Node)) closeNodeMenu() }
    onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeNodeMenu() }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
  }, 0)
}

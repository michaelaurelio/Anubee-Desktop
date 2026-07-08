// Right-click (cxttap) context menu for a graph node: Copy the node identifier,
// or Add Tag (opens a dedicated tag popup). A floating panel at the cursor,
// dismissed on outside-click / Esc. DOM side-effect, not unit-tested.

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
  onAddTag: () => void
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
  item('Add Tag', () => { closeNodeMenu(); opts.onAddTag() })

  document.body.appendChild(menu)
  setTimeout(() => {
    onDoc = (e: MouseEvent) => { if (menu && !menu.contains(e.target as Node)) closeNodeMenu() }
    onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeNodeMenu() }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
  }, 0)
}

// The dedicated Add-Tag popup: a themed floating panel hosting the tag editor,
// opened from the right-click menu's Add Tag item. Same lifecycle as the menu
// (fixed position, viewport clamp, dismiss on outside-click / Esc).
let tagPopup: HTMLDivElement | undefined
let onTagDoc: ((e: MouseEvent) => void) | undefined
let onTagKey: ((e: KeyboardEvent) => void) | undefined

export function closeTagPopup(): void {
  tagPopup?.remove(); tagPopup = undefined
  if (onTagDoc) { document.removeEventListener('mousedown', onTagDoc); onTagDoc = undefined }
  if (onTagKey) { document.removeEventListener('keydown', onTagKey); onTagKey = undefined }
}

interface TagOpts {
  nodeId: string
  anchor: { x: number; y: number }
  tagHost: (h: HTMLElement) => void
}

export function showTagPopup(opts: TagOpts): void {
  closeTagPopup()
  tagPopup = document.createElement('div')
  tagPopup.className = 'tag-popup'
  const x = Math.min(opts.anchor.x, window.innerWidth - 380)
  const y = Math.min(opts.anchor.y, window.innerHeight - 240)
  Object.assign(tagPopup.style, { position: 'fixed', left: Math.max(8, x) + 'px', top: Math.max(8, y) + 'px', zIndex: '60' })
  opts.tagHost(tagPopup)
  document.body.appendChild(tagPopup)
  setTimeout(() => {
    onTagDoc = (e: MouseEvent) => { if (tagPopup && !tagPopup.contains(e.target as Node)) closeTagPopup() }
    onTagKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeTagPopup() }
    document.addEventListener('mousedown', onTagDoc)
    document.addEventListener('keydown', onTagKey)
  }, 0)
}

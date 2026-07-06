import type { Tag } from '@shared/project-store'
import { badgeText } from './tag-view'

// Panel listing tags whose target no longer matches any node/edge in the active
// run (a re-ingest shifted ids). Hidden when there are none; each row offers a
// Drop, plus a Drop all. DOM side-effect, not unit-tested.
export function renderOrphans(
  host: HTMLElement,
  orphans: Tag[],
  onDrop: (target: string, offset?: string) => void,
  onDropAll: () => void,
): void {
  host.innerHTML = ''
  if (orphans.length === 0) {
    host.style.display = 'none'
    return
  }
  host.style.display = 'block'

  const head = document.createElement('div')
  head.style.fontWeight = 'bold'
  head.textContent = `Orphaned tags (${orphans.length})`
  host.appendChild(head)

  const hint = document.createElement('div')
  hint.style.color = '#8a6d3b'
  hint.textContent = 'Target no longer matches any node in this run.'
  host.appendChild(hint)

  for (const t of orphans) {
    const row = document.createElement('div')
    row.style.marginTop = '4px'
    row.textContent = `${badgeText([t])} ${t.target}${t.offset ? ' @ ' + t.offset : ''}${t.note ? ' - ' + t.note : ''}`
    const drop = document.createElement('button')
    drop.textContent = 'Drop'
    drop.style.marginLeft = '6px'
    drop.onclick = () => onDrop(t.target, t.offset)
    row.appendChild(drop)
    host.appendChild(row)
  }

  const all = document.createElement('button')
  all.textContent = 'Drop all'
  all.style.marginTop = '6px'
  all.onclick = onDropAll
  host.appendChild(all)
}

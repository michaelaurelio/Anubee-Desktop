import type { Tag, RaspCategory } from '@shared/project-store'

const CATEGORIES: RaspCategory[] = ['root', 'debugger', 'emulator', 'integrity', 'hook', 'custom']

// Compact badge of the distinct categories tagged on a target, in first-seen
// order: "[root,debugger]". Empty string when the target has no tags.
export function badgeText(tags: Tag[]): string {
  const seen: RaspCategory[] = []
  for (const t of tags) if (!seen.includes(t.category)) seen.push(t.category)
  return seen.length ? `[${seen.join(',')}]` : ''
}

// Build a manual tag; drop an empty note/offset so the sidecar stays clean.
export function newManualTag(
  target: string,
  category: RaspCategory,
  offset: string | undefined,
  note: string | undefined,
  now: string,
): Tag {
  const t: Tag = { target, category, source: 'manual', createdAt: now }
  if (offset) t.offset = offset
  if (note) t.note = note
  return t
}

// Render the tag editor for a target into a host element. `current` is the
// target's existing tags; `onSave`/`onRemove` persist and refresh. `offset` is
// the optional block refinement chosen from a backtrace frame (undefined = the
// whole node). DOM side-effect, not unit-tested.
export function renderTagEditor(
  host: HTMLElement,
  target: string,
  offset: string | undefined,
  current: Tag[],
  onSave: (tag: Tag) => void,
  onRemove: (target: string, offset?: string) => void,
): void {
  const box = document.createElement('div')
  box.className = 'tag-editor'

  const label = document.createElement('div')
  label.className = 'tag-editor-title'
  label.textContent = offset ? `Tag ${target} @ ${offset}` : `Tag ${target}`
  box.appendChild(label)

  const controls = document.createElement('div')
  controls.className = 'tag-editor-controls'

  const select = document.createElement('select')
  for (const c of CATEGORIES) {
    const opt = document.createElement('option')
    opt.value = c
    opt.textContent = c
    select.appendChild(opt)
  }
  controls.appendChild(select)

  const note = document.createElement('input')
  note.type = 'text'
  note.placeholder = 'note (optional)'
  controls.appendChild(note)

  const save = document.createElement('button')
  save.textContent = 'Save tag'
  save.onclick = () =>
    onSave(newManualTag(target, select.value as RaspCategory, offset, note.value, new Date().toISOString()))
  controls.appendChild(save)

  box.appendChild(controls)

  if (current.length) {
    const existing = document.createElement('div')
    existing.className = 'tag-existing'
    for (const t of current) {
      const row = document.createElement('div')
      row.textContent = `${badgeText([t])}${t.offset ? ' @ ' + t.offset : ''}${t.note ? ' - ' + t.note : ''} (${t.source})`
      const del = document.createElement('button')
      del.textContent = 'x'
      del.style.marginLeft = '6px'
      del.onclick = () => onRemove(t.target, t.offset)
      row.appendChild(del)
      existing.appendChild(row)
    }
    box.appendChild(existing)
  }

  host.appendChild(box)
}

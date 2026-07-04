import type { Filter } from '@shared/filter'

interface Inputs {
  text: string
  syscall: string
  library: string
  tid: string
  hasJava: boolean
}

// Build a Filter from raw toolbar input values. Pure: trims, omits empty fields,
// and includes `tid` only when it parses to an integer.
export function readFilterFrom(i: Inputs): Filter {
  const f: Filter = {}
  if (i.text.trim()) f.text = i.text.trim()
  if (i.syscall.trim()) f.syscall = i.syscall.trim()
  if (i.library.trim()) f.library = i.library.trim()
  const tid = Number(i.tid.trim())
  if (i.tid.trim() !== '' && Number.isInteger(tid)) f.tid = tid
  if (i.hasJava) f.hasJavaStack = true
  return f
}

function val(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value ?? ''
}
function checked(id: string): boolean {
  return (document.getElementById(id) as HTMLInputElement | null)?.checked ?? false
}

export function currentFilter(): Filter {
  return readFilterFrom({
    text: val('f-text'),
    syscall: val('f-syscall'),
    library: val('f-library'),
    tid: val('f-tid'),
    hasJava: checked('f-hasjava'),
  })
}

// Bind the Filter button + Enter in any text input to re-run the table query.
export function wireFilterControls(refresh: () => void): void {
  document.getElementById('apply')?.addEventListener('click', () => refresh())
  document.getElementById('f-hasjava')?.addEventListener('change', () => refresh())
  for (const id of ['f-text', 'f-syscall', 'f-library', 'f-tid']) {
    document.getElementById(id)?.addEventListener('keydown', e => {
      if ((e as KeyboardEvent).key === 'Enter') refresh()
    })
  }
}

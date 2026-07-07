import type { Rule, RuleMatch, RuleScope } from '@shared/rasp-heuristics'
import { validateRule, type RuleField, type RuleOp } from '@shared/rasp-heuristics'
import type { RaspCategory } from '@shared/project-store'

const CATEGORIES: RaspCategory[] = ['root', 'debugger', 'emulator', 'integrity', 'hook', 'custom']
const FIELDS: RuleField[] = ['string_args', 'fd_args', 'sock_addr', 'args']
const OPS: RuleOp[] = ['path_matches', 'equals', 'arg_hex_eq']

export interface RuleFormValues {
  id: string
  category: string
  confidence: number
  rationale: string
  enabled: boolean
  syscalls: string[]
  field: string
  op: string
  argIndex?: number
  value: string
}

// The raw rule object to hand to validateRule. argIndex only for arg_hex_eq.
export function draftFromForm(v: RuleFormValues): Record<string, unknown> {
  const match: Record<string, unknown> = {
    syscalls: v.syscalls, field: v.field, op: v.op, value: v.value,
  }
  if (v.op === 'arg_hex_eq') match.argIndex = v.argIndex ?? 0
  return {
    id: v.id, category: v.category, confidence: v.confidence,
    rationale: v.rationale, enabled: v.enabled, match,
  }
}

// Compact predicate for a list row: "args[0] arg_hex_eq 0x10" or
// "string_args path_matches /su/" or "fd_args equals /proc/self/status".
export function predicateSummary(m: RuleMatch): string {
  if (m.op === 'arg_hex_eq') return `args[${m.argIndex ?? 0}] arg_hex_eq ${m.value}`
  const val = m.op === 'path_matches' ? `/${m.value}/` : m.value
  return `${m.field} ${m.op} ${val}`
}

export function upsertRule(scope: RuleScope, rule: Rule): RuleScope {
  const rules = scope.rules.some(r => r.id === rule.id)
    ? scope.rules.map(r => (r.id === rule.id ? rule : r))
    : [...scope.rules, rule]
  return { rules, enabledOverrides: { ...scope.enabledOverrides } }
}

export function deleteRule(scope: RuleScope, id: string): RuleScope {
  const enabledOverrides = { ...scope.enabledOverrides }
  delete enabledOverrides[id]
  return { rules: scope.rules.filter(r => r.id !== id), enabledOverrides }
}

export function setEnabled(scope: RuleScope, id: string, enabled: boolean): RuleScope {
  return { rules: scope.rules.map(r => ({ ...r })), enabledOverrides: { ...scope.enabledOverrides, [id]: enabled } }
}

// Fetch, render list + editor, wire actions. onChange() fires after any save so
// the host can refresh the suggestions panel.
export async function renderRules(
  host: HTMLElement,
  activeRunId: number | undefined,
  onChange: () => void,
): Promise<void> {
  const data = await window.ares.rulesGet(activeRunId)
  host.innerHTML = ''

  const head = document.createElement('div')
  head.style.fontWeight = 'bold'
  head.textContent = `Rules (${data.effective.length})`
  host.appendChild(head)

  const status = document.createElement('div')
  status.dataset.role = 'rules-status'
  status.style.color = 'crimson'
  host.appendChild(status)

  // A row action's optimistic DOM change (e.g. a flipped checkbox) can outrun
  // its persist(); on rejection, resync the panel to persisted truth and show
  // the error on the freshly-rendered status line (the old `status` element
  // is gone once renderRules rebuilds the DOM).
  async function showError(err: unknown): Promise<void> {
    await renderRules(host, activeRunId, onChange)
    const fresh = host.querySelector<HTMLDivElement>('[data-role="rules-status"]')
    if (fresh) fresh.textContent = `⚠ ${(err as Error).message}`
  }

  // --- list ---
  for (const r of data.effective) {
    const row = document.createElement('div')
    row.style.padding = '2px 0'

    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = r.enabled
    cb.title = 'enable / disable'
    cb.onchange = () => { void toggle(r.id, r.source, cb.checked).catch(showError) }
    row.appendChild(cb)

    const label = document.createElement('span')
    label.textContent = ` [${r.source}] ${r.id} · ${r.category} ${(r.confidence * 100).toFixed(0)}% · ${r.match.syscalls.join(',')} · ${predicateSummary(r.match)} `
    row.appendChild(label)

    const edit = document.createElement('button')
    edit.textContent = 'Edit'
    edit.onclick = () => openForm(r)
    row.appendChild(edit)

    if (r.source !== 'builtin') {
      const del = document.createElement('button')
      del.textContent = 'Delete'
      del.onclick = () => { void remove(r.id, r.source).catch(showError) }
      row.appendChild(del)
    } else {
      const reset = document.createElement('button')
      reset.textContent = 'Reset'
      reset.title = 'drop any override / shadow of this builtin'
      reset.onclick = () => { void resetBuiltin(r.id).catch(showError) }
      row.appendChild(reset)
    }
    host.appendChild(row)
  }

  const addBtn = document.createElement('button')
  addBtn.textContent = 'New rule'
  addBtn.onclick = () => openForm(null)
  host.appendChild(addBtn)

  const formHost = document.createElement('div')
  host.appendChild(formHost)

  // --- persistence: pick the scope object to mutate, then save it ---
  async function persist(scope: 'global' | 'project', next: RuleScope): Promise<void> {
    await window.ares.rulesSave(scope, next, activeRunId)
    onChange()
    await renderRules(host, activeRunId, onChange) // re-fetch + re-render
  }

  async function toggle(id: string, source: string, enabled: boolean): Promise<void> {
    // Global/project rules toggle in their own scope; a builtin's override
    // goes to the project (run-local) scope.
    const scope: 'global' | 'project' = source === 'global' ? 'global' : 'project'
    const base = scope === 'global' ? data.global : data.project
    await persist(scope, setEnabled(base, id, enabled))
  }

  async function remove(id: string, source: string): Promise<void> {
    const scope: 'global' | 'project' = source === 'global' ? 'global' : 'project'
    const base = scope === 'global' ? data.global : data.project
    await persist(scope, deleteRule(base, id))
  }

  async function resetBuiltin(id: string): Promise<void> {
    // clear the id from both writable scopes (shadow rule + any override)
    await window.ares.rulesSave('global', deleteRule(data.global, id), activeRunId)
    await window.ares.rulesSave('project', deleteRule(data.project, id), activeRunId)
    onChange()
    await renderRules(host, activeRunId, onChange)
  }

  // --- editor form ---
  function openForm(existing: Rule | null): void {
    formHost.innerHTML = ''
    const mk = (labelText: string, el: HTMLElement) => {
      const wrap = document.createElement('label')
      wrap.style.display = 'block'
      wrap.textContent = labelText + ' '
      wrap.appendChild(el)
      formHost.appendChild(wrap)
    }
    const idIn = document.createElement('input'); idIn.value = existing?.id ?? ''
    const catSel = select(CATEGORIES, existing?.category ?? 'custom')
    const confIn = document.createElement('input'); confIn.type = 'number'; confIn.step = '0.05'; confIn.min = '0'; confIn.max = '1'; confIn.value = String(existing?.confidence ?? 0.5)
    const ratIn = document.createElement('input'); ratIn.value = existing?.rationale ?? ''
    const sysIn = document.createElement('input'); sysIn.placeholder = 'openat, access'; sysIn.value = existing?.match.syscalls.join(', ') ?? ''
    const fieldSel = select(FIELDS, existing?.match.field ?? 'string_args')
    const opSel = select(OPS, existing?.match.op ?? 'path_matches')
    const argIn = document.createElement('input'); argIn.type = 'number'; argIn.min = '0'; argIn.value = String(existing?.match.argIndex ?? 0)
    const valIn = document.createElement('input'); valIn.value = existing?.match.value ?? ''
    const scopeSel = select(['project', 'global'], existing?.source === 'global' ? 'global' : 'project')
    const preview = document.createElement('div'); preview.style.padding = '4px 0'

    const argWrap = () => { argIn.parentElement!.style.display = opSel.value === 'arg_hex_eq' ? 'block' : 'none' }

    mk('id', idIn); mk('category', catSel); mk('confidence', confIn); mk('rationale', ratIn)
    mk('syscalls', sysIn); mk('field', fieldSel); mk('op', opSel); mk('argIndex', argIn); mk('value', valIn)
    mk('scope', scopeSel)
    formHost.appendChild(preview)
    argWrap()
    opSel.onchange = () => { argWrap(); refreshPreview() }

    function values(): RuleFormValues {
      return {
        id: idIn.value.trim(), category: catSel.value, confidence: Number(confIn.value),
        rationale: ratIn.value, enabled: existing?.enabled ?? true,
        syscalls: sysIn.value.split(',').map(s => s.trim()).filter(Boolean),
        field: fieldSel.value, op: opSel.value, argIndex: Number(argIn.value), value: valIn.value,
      }
    }

    let previewTimer: ReturnType<typeof setTimeout> | undefined
    function refreshPreview(): void {
      clearTimeout(previewTimer)
      const { rule, error } = validateRule(draftFromForm(values()), scopeSel.value === 'global' ? 'global' : 'project')
      if (!rule) { preview.textContent = `⚠ ${error}`; return }
      previewTimer = setTimeout(() => {
        void window.ares.rulesPreview(rule, activeRunId).then(res => {
          preview.textContent = 'error' in res
            ? `⚠ ${res.error}`
            : `matches ${res.events} events → ${res.targets} targets`
        })
      }, 250)
    }
    for (const el of [idIn, catSel, confIn, ratIn, sysIn, fieldSel, argIn, valIn, scopeSel]) {
      el.addEventListener('input', refreshPreview)
      el.addEventListener('change', refreshPreview)
    }
    refreshPreview()

    const save = document.createElement('button'); save.textContent = 'Save'
    save.onclick = async () => {
      const scope: 'global' | 'project' = scopeSel.value === 'global' ? 'global' : 'project'
      const { rule, error } = validateRule(draftFromForm(values()), scope)
      if (!rule) { preview.textContent = `⚠ ${error}`; return }
      // Compose the final state of each writable scope from the current data, so a
      // scope-change or id-rename removes the rule's prior identity (avoiding an
      // orphaned copy that resolveRules' later-scope-wins could shadow with).
      const edits: Record<'global' | 'project', RuleScope> = { global: data.global, project: data.project }
      const changed = new Set<'global' | 'project'>([scope])
      if (existing && existing.source !== 'builtin') {
        const src = existing.source as 'global' | 'project'
        edits[src] = deleteRule(edits[src], existing.id)
        changed.add(src)
      }
      edits[scope] = upsertRule(edits[scope], rule)
      try {
        for (const s of changed) await window.ares.rulesSave(s, edits[s], activeRunId)
        onChange()
        await renderRules(host, activeRunId, onChange)
      } catch (e) {
        preview.textContent = `⚠ ${(e as Error).message}`
      }
    }
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel'
    cancel.onclick = () => { formHost.innerHTML = '' }
    formHost.appendChild(save); formHost.appendChild(cancel)
  }
}

function select(opts: readonly string[], selected: string): HTMLSelectElement {
  const s = document.createElement('select')
  for (const o of opts) {
    const opt = document.createElement('option'); opt.value = o; opt.textContent = o
    if (o === selected) opt.selected = true
    s.appendChild(opt)
  }
  return s
}

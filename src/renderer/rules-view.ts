import type { Rule, RuleMatch, RuleScope, RuleStep } from '@shared/rasp-heuristics'
import { validateRule, type RuleField, type RuleOp } from '@shared/rasp-heuristics'
import type { RaspCategory } from '@shared/project-store'

const CATEGORIES: RaspCategory[] = ['root', 'debugger', 'emulator', 'integrity', 'hook', 'custom']
const FIELDS: RuleField[] = ['string_args', 'fd_args', 'sock_addr', 'args']
const OPS: RuleOp[] = ['path_matches', 'equals', 'arg_hex_eq']
const CORRELATES = ['symbol', 'symbol+tid', 'module', 'module+tid', 'java']

export interface StepFormValues {
  syscalls: string[]
  field: string
  op: string
  argIndex?: number
  value: string
}

export interface RuleFormValues {
  id: string
  category: string
  confidence: number
  rationale: string
  enabled: boolean
  correlate: string
  maxGap: number
  steps: StepFormValues[]
}

// The raw rule object to hand to validateRule. argIndex only for arg_hex_eq.
export function draftFromForm(v: RuleFormValues): Record<string, unknown> {
  const steps = v.steps.map(s => {
    const step: Record<string, unknown> = { syscalls: s.syscalls, field: s.field, op: s.op, value: s.value }
    if (s.op === 'arg_hex_eq') step.argIndex = s.argIndex ?? 0
    return step
  })
  return {
    id: v.id, category: v.category, confidence: v.confidence,
    rationale: v.rationale, enabled: v.enabled,
    correlate: v.correlate, maxGap: v.maxGap, steps,
  }
}

// Compact predicate for a list row: "args[0] arg_hex_eq 0x10" or
// "string_args path_matches /su/" or "fd_args equals /proc/self/status".
export function predicateSummary(m: RuleMatch): string {
  if (m.op === 'arg_hex_eq') return `args[${m.argIndex ?? 0}] arg_hex_eq ${m.value}`
  const val = m.op === 'path_matches' ? `/${m.value}/` : m.value
  return `${m.field} ${m.op} ${val}`
}

// One line for a list row: each step's predicate, in order.
export function sequenceSummary(r: Rule): string {
  return r.steps.map(predicateSummary).join(' → ')
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
  const data = await window.anubee.rulesGet(activeRunId)
  host.innerHTML = ''

  const head = document.createElement('div')
  head.className = 'rules-head'
  head.textContent = `Rules (${data.effective.length})`
  host.appendChild(head)

  const status = document.createElement('div')
  status.className = 'rules-status'
  status.dataset.role = 'rules-status'
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
    const row = document.createElement('div'); row.className = 'rule-row' + (r.enabled ? '' : ' disabled')
    const info = document.createElement('div'); info.className = 'rule-info'
    const line1 = document.createElement('div'); line1.className = 'rule-line1'
    const cat = document.createElement('span'); cat.className = `cat-chip cat-${r.category}`; cat.textContent = r.category.toUpperCase()
    const src = document.createElement('span'); src.className = 'rule-src'; src.textContent = r.source
    const id = document.createElement('span'); id.className = 'rule-id'; id.textContent = r.id
    const meta = document.createElement('span'); meta.className = 'rule-meta'
    meta.textContent = `${(r.confidence * 100).toFixed(0)}% · ${r.steps[0].syscalls.join(',')}`
    line1.append(cat, src, id, meta)
    const pred = document.createElement('div'); pred.className = 'rule-pred'; pred.textContent = sequenceSummary(r)
    info.append(line1, pred)

    const btns = document.createElement('div'); btns.className = 'rule-btns'
    const sw = document.createElement('button')
    sw.className = 'rule-sw' + (r.enabled ? '' : ' off')
    sw.title = 'enable / disable'
    sw.onclick = () => { void toggle(r.id, r.source, !r.enabled).catch(showError) }
    const edit = document.createElement('button'); edit.className = 'btn'; edit.textContent = 'Edit'; edit.onclick = () => openForm(r)
    btns.append(sw, edit)
    if (r.source !== 'builtin') {
      const del = document.createElement('button'); del.className = 'btn'; del.textContent = 'Delete'
      del.onclick = () => { void remove(r.id, r.source).catch(showError) }
      btns.appendChild(del)
    } else {
      const reset = document.createElement('button'); reset.className = 'btn'; reset.textContent = 'Reset'
      reset.title = 'drop any override / shadow of this builtin'
      reset.onclick = () => { void resetBuiltin(r.id).catch(showError) }
      btns.appendChild(reset)
    }
    row.append(info, btns)
    host.appendChild(row)
  }

  const addWrap = document.createElement('div')
  addWrap.style.marginTop = '10px'
  const addBtn = document.createElement('button')
  addBtn.className = 'btn'
  addBtn.textContent = 'New rule'
  addBtn.onclick = () => openForm(null)
  addWrap.appendChild(addBtn)
  host.appendChild(addWrap)

  const formHost = document.createElement('div')
  host.appendChild(formHost)

  // --- persistence: pick the scope object to mutate, then save it ---
  async function persist(scope: 'global' | 'project', next: RuleScope): Promise<void> {
    await window.anubee.rulesSave(scope, next, activeRunId)
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
    await window.anubee.rulesSave('global', deleteRule(data.global, id), activeRunId)
    await window.anubee.rulesSave('project', deleteRule(data.project, id), activeRunId)
    onChange()
    await renderRules(host, activeRunId, onChange)
  }

  // --- editor form ---
  function openForm(existing: Rule | null): void {
    formHost.innerHTML = ''
    const wrap = document.createElement('div'); wrap.className = 'rule-form'; formHost.appendChild(wrap)
    const mk = (labelText: string, el: HTMLElement): HTMLSpanElement => {
      const lab = document.createElement('span'); lab.className = 'rf-label'; lab.textContent = labelText
      wrap.append(lab, el)
      return lab
    }
    const idIn = document.createElement('input'); idIn.value = existing?.id ?? ''
    const catSel = select(CATEGORIES, existing?.category ?? 'custom')
    const confIn = document.createElement('input'); confIn.type = 'number'; confIn.step = '0.05'; confIn.min = '0'; confIn.max = '1'; confIn.value = String(existing?.confidence ?? 0.5)
    const ratIn = document.createElement('input'); ratIn.value = existing?.rationale ?? ''
    const correlateSel = select(CORRELATES, existing?.correlate ?? 'symbol+tid')
    const gapIn = document.createElement('input')
    gapIn.type = 'number'; gapIn.min = '1'; gapIn.value = String(existing?.maxGap ?? 50)
    const scopeSel = select(['project', 'global'], existing?.source === 'global' ? 'global' : 'project')
    const preview = document.createElement('div')

    const stepsHost = document.createElement('div')
    stepsHost.className = 'rf-steps'
    interface StepControls { sysIn: HTMLInputElement; fieldSel: HTMLSelectElement; opSel: HTMLSelectElement; argIn: HTMLInputElement; valIn: HTMLInputElement }
    const stepControls: StepControls[] = []

    function addStepBlock(init?: RuleStep): void {
      const block = document.createElement('div')
      block.className = 'rf-step'
      const heading = document.createElement('div')
      heading.className = 'rf-step-head'
      const sysIn = document.createElement('input'); sysIn.placeholder = 'openat, access'; sysIn.value = init?.syscalls.join(', ') ?? ''
      const fieldSel = select(FIELDS, init?.field ?? 'string_args')
      const opSel = select(OPS, init?.op ?? 'path_matches')
      const argIn = document.createElement('input'); argIn.type = 'number'; argIn.min = '0'; argIn.value = String(init?.argIndex ?? 0)
      const valIn = document.createElement('input'); valIn.value = init?.value ?? ''
      const ctl: StepControls = { sysIn, fieldSel, opSel, argIn, valIn }

      const del = document.createElement('button')
      del.className = 'btn rf-step-del'
      del.textContent = 'Remove step'
      del.onclick = () => {
        if (stepControls.length === 1) return   // a rule always has at least one step
        stepControls.splice(stepControls.indexOf(ctl), 1)
        block.remove()
        renumber()
        syncStepButtons()
        refreshPreview()
      }
      heading.append(document.createElement('span'), del)
      block.append(heading)
      for (const [label, el] of [['syscalls', sysIn], ['field', fieldSel], ['op', opSel], ['argIndex', argIn], ['value', valIn]] as const) {
        const wrapRow = document.createElement('label')
        wrapRow.className = 'rf-row'
        const lab = document.createElement('span'); lab.className = 'rf-label'; lab.textContent = label
        wrapRow.append(lab, el)
        block.append(wrapRow)
        if (label === 'argIndex') {
          const sync = () => { wrapRow.style.display = opSel.value === 'arg_hex_eq' ? '' : 'none' }
          sync()
          opSel.addEventListener('change', () => { sync(); refreshPreview() })
        }
        el.addEventListener('input', refreshPreview)
        el.addEventListener('change', refreshPreview)
      }
      stepControls.push(ctl)
      stepsHost.append(block)
      renumber()
      syncStepButtons()
    }

    function renumber(): void {
      stepsHost.querySelectorAll('.rf-step-head > span:first-child').forEach((el, i) => {
        el.textContent = `step ${i + 1}`
      })
    }

    // A rule always has at least one step, so Remove step is disabled while
    // only one block remains (re-enabled the moment a second is added).
    function syncStepButtons(): void {
      const onlyOne = stepControls.length === 1
      stepsHost.querySelectorAll<HTMLButtonElement>('.rf-step-del').forEach(btn => { btn.disabled = onlyOne })
    }

    const addStep = document.createElement('button')
    addStep.className = 'btn rf-step-add'
    addStep.textContent = 'Add step'
    addStep.onclick = () => { addStepBlock(); refreshPreview() }

    for (const s of existing?.steps ?? [undefined]) addStepBlock(s)

    mk('id', idIn); mk('category', catSel); mk('confidence', confIn); mk('rationale', ratIn)
    mk('correlate', correlateSel); mk('maxGap', gapIn)
    wrap.append(stepsHost, addStep)
    mk('scope', scopeSel)
    preview.className = 'rf-preview'; wrap.appendChild(preview)

    function values(): RuleFormValues {
      return {
        id: idIn.value.trim(), category: catSel.value, confidence: Number(confIn.value),
        rationale: ratIn.value, enabled: existing?.enabled ?? true,
        correlate: correlateSel.value, maxGap: Number(gapIn.value),
        steps: stepControls.map(c => ({
          syscalls: c.sysIn.value.split(',').map(s => s.trim()).filter(Boolean),
          field: c.fieldSel.value, op: c.opSel.value,
          argIndex: Number(c.argIn.value), value: c.valIn.value,
        })),
      }
    }

    let previewTimer: ReturnType<typeof setTimeout> | undefined
    function refreshPreview(): void {
      clearTimeout(previewTimer)
      const { rule, error } = validateRule(draftFromForm(values()), scopeSel.value === 'global' ? 'global' : 'project')
      if (!rule) { preview.textContent = `⚠ ${error}`; return }
      previewTimer = setTimeout(() => {
        void window.anubee.rulesPreview(rule, activeRunId).then(res => {
          preview.textContent = 'error' in res
            ? `⚠ ${res.error}`
            : `matches ${res.events} events → ${res.targets} targets`
        })
      }, 250)
    }
    for (const el of [idIn, catSel, confIn, ratIn, correlateSel, gapIn, scopeSel]) {
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
        for (const s of changed) await window.anubee.rulesSave(s, edits[s], activeRunId)
        onChange()
        await renderRules(host, activeRunId, onChange)
      } catch (e) {
        preview.textContent = `⚠ ${(e as Error).message}`
      }
    }
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel'
    cancel.onclick = () => { formHost.innerHTML = '' }
    const actions = document.createElement('div'); actions.className = 'rf-actions'
    save.className = 'btn pri'; cancel.className = 'btn'
    actions.append(cancel, save); wrap.appendChild(actions)
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

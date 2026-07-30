// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { draftFromForm, predicateSummary, sequenceSummary, upsertRule, deleteRule, setEnabled, renderRules } from '../src/renderer/rules-view'
import { validateRule } from '@shared/rasp-heuristics'
import type { Rule, RuleScope } from '@shared/rasp-heuristics'

const R: Rule = {
  id: 'a', category: 'root', confidence: 0.8, rationale: 'r', enabled: true, source: 'global',
  steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'su' }],
  correlate: 'symbol+tid', maxGap: 50, mode: 'ordered', minOccurrences: 1,
}

describe('rules-view helpers', () => {
  it('draftFromForm omits argIndex for non-hex ops', () => {
    const d = draftFromForm({ id: 'a', category: 'root', confidence: 0.8, rationale: 'r', enabled: true,
      correlate: 'symbol+tid', maxGap: 50, mode: 'ordered', minOccurrences: 1,
      steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'su' }] })
    expect(d).toEqual({ id: 'a', category: 'root', confidence: 0.8, rationale: 'r', enabled: true,
      correlate: 'symbol+tid', maxGap: 50, mode: 'ordered', minOccurrences: 1,
      steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'su' }] })
  })

  it('draftFromForm includes argIndex for arg_hex_eq', () => {
    const d = draftFromForm({ id: 'p', category: 'debugger', confidence: 0.7, rationale: 'r', enabled: true,
      correlate: 'symbol+tid', maxGap: 50, mode: 'ordered', minOccurrences: 1,
      steps: [{ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0x10' }] })
    expect((d.steps as Record<string, unknown>[])[0].argIndex).toBe(0)
  })

  it('builds a multi-step draft the validator accepts', () => {
    const draft = draftFromForm({
      id: 'seq', category: 'hook', confidence: 0.9, rationale: 'r', enabled: true,
      correlate: 'module+tid', maxGap: 10, mode: 'ordered', minOccurrences: 1,
      steps: [
        { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: '/proc/self/maps$' },
        { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'frida' },
      ],
    })
    const { rule, error } = validateRule(draft, 'project')
    expect(error).toBeNull()
    expect(rule!.steps).toHaveLength(2)
    expect(rule!.correlate).toBe('module+tid')
    expect(rule!.maxGap).toBe(10)
  })

  it('summarises a sequence as its steps joined by an arrow', () => {
    expect(sequenceSummary({
      id: 'x', category: 'hook', confidence: 0.9, rationale: 'r', enabled: true, source: 'project',
      correlate: 'module+tid', maxGap: 10, mode: 'ordered', minOccurrences: 1,
      steps: [
        { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'maps' },
        { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'frida' },
      ],
    })).toBe('string_args path_matches /maps/ → string_args path_matches /frida/')
  })

  it('predicateSummary renders path and hex predicates', () => {
    expect(predicateSummary(R.steps[0])).toBe('string_args path_matches /su/')
    expect(predicateSummary({ syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 0, value: '0x10' }))
      .toBe('args[0] arg_hex_eq 0x10')
  })

  it('upsertRule replaces by id', () => {
    const scope: RuleScope = { rules: [R], enabledOverrides: {} }
    const next = upsertRule(scope, { ...R, confidence: 0.9 })
    expect(next.rules).toHaveLength(1)
    expect(next.rules[0].confidence).toBe(0.9)
    expect(scope.rules[0].confidence).toBe(0.8) // original untouched
  })

  it('deleteRule removes the rule and its override', () => {
    const scope: RuleScope = { rules: [R], enabledOverrides: { a: false } }
    const next = deleteRule(scope, 'a')
    expect(next.rules).toHaveLength(0)
    expect(next.enabledOverrides).toEqual({})
  })

  it('setEnabled writes an override', () => {
    expect(setEnabled({ rules: [], enabledOverrides: {} }, 'dbg-ptrace-traceme', false).enabledOverrides)
      .toEqual({ 'dbg-ptrace-traceme': false })
  })
})

// --- editor form (DOM) ---

const twoStepRule: Rule = {
  id: 'seq2', category: 'hook', confidence: 0.9, rationale: 'r', enabled: true, source: 'project',
  correlate: 'module+tid', maxGap: 20, mode: 'ordered', minOccurrences: 1,
  steps: [
    { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'maps' },
    { syscalls: ['ptrace'], field: 'args', op: 'arg_hex_eq', argIndex: 2, value: '0x10' },
  ],
}

const threeStepRule: Rule = {
  id: 'seq3', category: 'hook', confidence: 0.9, rationale: 'r', enabled: true, source: 'project',
  correlate: 'module+tid', maxGap: 10, mode: 'ordered', minOccurrences: 1,
  steps: [
    { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'alpha' },
    { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'beta' },
    { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'gamma' },
  ],
}

function stubAnubee(effective: Rule[], global: RuleScope = { rules: [], enabledOverrides: {} }, project: RuleScope = { rules: [], enabledOverrides: {} }): void {
  ;(window as unknown as { anubee: Record<string, unknown> }).anubee = {
    rulesGet: async () => ({ builtin: [], global, project, effective }),
    rulesPreview: async () => ({ events: 0, targets: 0 }),
    rulesSave: async () => undefined,
  }
}

function findButton(root: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(root.querySelectorAll('button')).find(b => b.textContent === text)
  if (!btn) throw new Error(`button "${text}" not found`)
  return btn
}

async function openNewRuleForm(): Promise<HTMLElement> {
  stubAnubee([])
  const host = document.createElement('div')
  await renderRules(host, undefined, () => {})
  findButton(host, 'New rule').click()
  return host.querySelector('.rule-form') as HTMLElement
}

async function openEditForm(rule: Rule): Promise<HTMLElement> {
  stubAnubee([rule])
  const host = document.createElement('div')
  await renderRules(host, undefined, () => {})
  findButton(host, 'Edit').click()
  return host.querySelector('.rule-form') as HTMLElement
}

function stepBlocks(form: HTMLElement): HTMLElement[] {
  return Array.from(form.querySelectorAll<HTMLElement>('.rf-step'))
}

function headingOf(block: HTMLElement): string {
  return block.querySelector('.rf-step-head > span:first-child')?.textContent ?? ''
}

function removeBtnOf(block: HTMLElement): HTMLButtonElement {
  return block.querySelector('.rf-step-del') as HTMLButtonElement
}

// argIndex is the 4th rf-row in a step block (syscalls, field, op, argIndex, value).
function argRowOf(block: HTMLElement): HTMLElement {
  return block.querySelectorAll<HTMLElement>('.rf-row')[3]
}

function stepValues(block: HTMLElement) {
  const inputs = block.querySelectorAll<HTMLInputElement>('input')
  const selects = block.querySelectorAll<HTMLSelectElement>('select')
  return {
    sysIn: inputs[0], argIn: inputs[1], valIn: inputs[2],
    fieldSel: selects[0], opSel: selects[1],
  }
}

describe('rules-view editor form (DOM)', () => {
  // Opening a form starts refreshPreview's 250ms debounce (previewTimer in
  // rules-view.ts); none of these tests close the form or wait it out, so a
  // real setTimeout is left pending past the test's end. Fake timers keep it
  // from ever firing for real - useRealTimers() in afterEach discards it
  // instead of letting it fire against a jsdom environment the file has
  // already torn down.
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('Add step appends a new numbered step block and renumbers headings', async () => {
    const form = await openNewRuleForm()
    expect(stepBlocks(form)).toHaveLength(1)
    expect(headingOf(stepBlocks(form)[0])).toBe('step 1')

    findButton(form, 'Add step').click()

    const blocks = stepBlocks(form)
    expect(blocks).toHaveLength(2)
    expect(headingOf(blocks[0])).toBe('step 1')
    expect(headingOf(blocks[1])).toBe('→ step 2')
  })

  it('refuses to remove the last remaining step', async () => {
    const form = await openNewRuleForm()
    expect(stepBlocks(form)).toHaveLength(1)

    removeBtnOf(stepBlocks(form)[0]).click()

    expect(stepBlocks(form)).toHaveLength(1)
  })

  it('disables Remove step when a one-step rule is first rendered', async () => {
    const form = await openNewRuleForm()
    expect(stepBlocks(form)).toHaveLength(1)

    expect(removeBtnOf(stepBlocks(form)[0]).disabled).toBe(true)
  })

  it('renders a two-step rule with Remove step enabled on both blocks', async () => {
    const form = await openEditForm(twoStepRule)
    const blocks = stepBlocks(form)
    expect(blocks).toHaveLength(2)

    expect(removeBtnOf(blocks[0]).disabled).toBe(false)
    expect(removeBtnOf(blocks[1]).disabled).toBe(false)
  })

  it('enables Remove step on all blocks once Add step brings the count to two', async () => {
    const form = await openNewRuleForm()
    expect(removeBtnOf(stepBlocks(form)[0]).disabled).toBe(true)

    findButton(form, 'Add step').click()

    const blocks = stepBlocks(form)
    expect(blocks).toHaveLength(2)
    expect(removeBtnOf(blocks[0]).disabled).toBe(false)
    expect(removeBtnOf(blocks[1]).disabled).toBe(false)
  })

  it('disables Remove step again once removal brings a rule back down to one step', async () => {
    const form = await openEditForm(twoStepRule)
    expect(stepBlocks(form)).toHaveLength(2)

    removeBtnOf(stepBlocks(form)[1]).click()

    const blocks = stepBlocks(form)
    expect(blocks).toHaveLength(1)
    expect(removeBtnOf(blocks[0]).disabled).toBe(true)
  })

  it('removes the targeted step from a multi-step rule and renumbers survivors with no gap', async () => {
    const form = await openEditForm(threeStepRule)
    expect(stepBlocks(form)).toHaveLength(3)

    removeBtnOf(stepBlocks(form)[1]).click() // remove the middle step ('beta')

    const blocks = stepBlocks(form)
    expect(blocks).toHaveLength(2)
    expect(headingOf(blocks[0])).toBe('step 1')
    expect(headingOf(blocks[1])).toBe('→ step 2')
    expect(stepValues(blocks[0]).valIn.value).toBe('alpha')
    expect(stepValues(blocks[1]).valIn.value).toBe('gamma')
  })

  it('shows argIndex only for the step whose op is arg_hex_eq, leaving sibling steps hidden', async () => {
    // Three steps, with step 2 the *middle* one (not the last block created) -
    // a closure that got captured by loop reference instead of per-call value
    // would route step 2's change event to whichever block was built last.
    const form = await openNewRuleForm()
    findButton(form, 'Add step').click()
    findButton(form, 'Add step').click()
    const [block1, block2, block3] = stepBlocks(form)

    // all default to path_matches, so all argIndex rows start hidden
    expect(argRowOf(block1).style.display).toBe('none')
    expect(argRowOf(block2).style.display).toBe('none')
    expect(argRowOf(block3).style.display).toBe('none')

    const op2 = stepValues(block2).opSel
    op2.value = 'arg_hex_eq'
    op2.dispatchEvent(new Event('change', { bubbles: true }))

    expect(argRowOf(block2).style.display).toBe('')
    expect(argRowOf(block1).style.display).toBe('none') // earlier sibling untouched
    expect(argRowOf(block3).style.display).toBe('none') // later sibling untouched
  })

  it('prefills both steps of a two-step rule on edit', async () => {
    const form = await openEditForm(twoStepRule)
    const blocks = stepBlocks(form)
    expect(blocks).toHaveLength(2)

    const s1 = stepValues(blocks[0])
    expect(s1.sysIn.value).toBe('openat')
    expect(s1.fieldSel.value).toBe('string_args')
    expect(s1.opSel.value).toBe('path_matches')
    expect(s1.valIn.value).toBe('maps')

    const s2 = stepValues(blocks[1])
    expect(s2.sysIn.value).toBe('ptrace')
    expect(s2.fieldSel.value).toBe('args')
    expect(s2.opSel.value).toBe('arg_hex_eq')
    expect(s2.argIn.value).toBe('2')
    expect(s2.valIn.value).toBe('0x10')
  })

  it('still prefills a single-step rule on edit', async () => {
    const form = await openEditForm(R)
    const blocks = stepBlocks(form)
    expect(blocks).toHaveLength(1)

    const s = stepValues(blocks[0])
    expect(s.sysIn.value).toBe('openat')
    expect(s.fieldSel.value).toBe('string_args')
    expect(s.opSel.value).toBe('path_matches')
    expect(s.valIn.value).toBe('su')
  })
})

describe('rules-view v3 form', () => {
  const form = (over: Record<string, unknown> = {}, step: Record<string, unknown> = {}) => ({
    id: 'a', category: 'root', confidence: 0.8, rationale: 'r', enabled: true,
    correlate: 'symbol+tid', maxGap: 50, mode: 'ordered', minOccurrences: 1,
    steps: [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'su', ...step }],
    ...over,
  }) as never

  it('carries mode and minOccurrences into the draft', () => {
    const d = draftFromForm(form({ mode: 'unordered', minOccurrences: 20 }))
    expect(d.mode).toBe('unordered')
    expect(d.minOccurrences).toBe(20)
    expect(validateRule(d, 'global').rule!.mode).toBe('unordered')
  })

  it("omits field and value for op:'any'", () => {
    const d = draftFromForm(form({}, { op: 'any', field: 'string_args', value: '' }))
    const s = (d.steps as Record<string, unknown>[])[0]
    expect(s.field).toBeUndefined()
    expect(s.value).toBeUndefined()
    expect(validateRule({ ...d, steps: [{ syscalls: ['process_vm_readv'], op: 'any' }] }, 'global').error).toBeNull()
  })

  it('includes argIndex for arg_hex_in', () => {
    const d = draftFromForm(form({}, { op: 'arg_hex_in', field: 'args', argIndex: 0, value: '0x7 0x10' }))
    expect((d.steps as Record<string, unknown>[])[0].argIndex).toBe(0)
  })

  it('emits a retval condition only when an operator is chosen', () => {
    const none = draftFromForm(form({}, { retvalOp: '', retvalValue: 0 }))
    expect((none.steps as Record<string, unknown>[])[0].retval).toBeUndefined()
    const some = draftFromForm(form({}, { retvalOp: 'eq', retvalValue: 0 }))
    expect((some.steps as Record<string, unknown>[])[0].retval).toEqual({ op: 'eq', value: 0 })
  })

  it('joins an unordered summary with + and an ordered one with an arrow', () => {
    const two = [{ syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'a' },
                 { syscalls: ['openat'], field: 'string_args', op: 'path_matches', value: 'b' }] as never
    expect(sequenceSummary({ ...R, steps: two, mode: 'unordered' })).toContain(' + ')
    expect(sequenceSummary({ ...R, steps: two, mode: 'ordered' })).toContain(' → ')
  })

  it('summarises an any step without a field', () => {
    expect(predicateSummary({ syscalls: ['process_vm_readv'], op: 'any' } as never))
      .toBe('any process_vm_readv')
  })
})

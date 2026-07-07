import type { Rule, RuleMatch, RuleScope } from '@shared/rasp-heuristics'

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

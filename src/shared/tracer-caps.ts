// Capability registry for feature 9 (tracer control). Pure: turns a chosen
// engine + form values into an ares argv. Device paths and the su -c wrapping
// live in composeRunArg (Task 2); this module owns only the per-engine argv.
// Verified against ../ARES src/*/*.c argp tables (see spec s2).

export type OutputKind = 'jsonl' | 'stdout' | 'artifact'
export type InputKind = 'package' | 'text' | 'bool' | 'csv' | 'pattern' | 'spec' | 'analyzer'

export interface CapInput {
  key: string
  label: string
  kind: InputKind
  required?: boolean
}

export type CapValues = Record<string, string | boolean | undefined>

export interface Capability {
  id: string
  label: string
  engine: string
  outputKind: OutputKind
  loud?: boolean
  inputs: CapInput[]
  buildArgv(vals: CapValues): string[]
}

export const DEVICE_SPECS = '/data/local/tmp/specs'

const s = (v: CapValues[string]): string => (typeof v === 'string' ? v : '')

export const CAPABILITIES: Capability[] = [
  {
    id: 'syscalls', label: 'syscalls (stealthy)', engine: 'syscalls', outputKind: 'jsonl',
    inputs: [
      { key: 'pkg', label: 'package', kind: 'package', required: true },
      { key: 'lib', label: 'library filter', kind: 'text' },
      { key: 'all', label: 'capture all libraries', kind: 'bool' },
      { key: 'syscalls', label: 'syscalls (csv)', kind: 'csv' },
    ],
    buildArgv(v) {
      const a = ['syscalls', '-P', s(v.pkg)]
      if (v.all) a.push('-a')
      else if (v.lib) a.push('-l', s(v.lib))
      if (v.syscalls) a.push('-s', s(v.syscalls))
      return a
    },
  },
  {
    id: 'funcs', label: 'funcs (uprobe, detectable)', engine: 'funcs', outputKind: 'jsonl',
    inputs: [
      { key: 'pkg', label: 'package', kind: 'package', required: true },
      { key: 'spec', label: 'probe spec', kind: 'spec', required: true },
    ],
    buildArgv(v) {
      return ['funcs', '-P', s(v.pkg), '-F', `${DEVICE_SPECS}/${s(v.spec)}`]
    },
  },
  {
    id: 'correlate', label: 'correlate (loud)', engine: 'correlate', outputKind: 'jsonl', loud: true,
    inputs: [
      { key: 'pkg', label: 'package', kind: 'package', required: true },
      { key: 'spec', label: 'probe spec', kind: 'spec', required: true },
    ],
    buildArgv(v) {
      return ['correlate', '-P', s(v.pkg), '-F', `${DEVICE_SPECS}/${s(v.spec)}`]
    },
  },
  {
    id: 'trace', label: 'trace (syscalls+funcs, loud)', engine: 'trace', outputKind: 'jsonl', loud: true,
    inputs: [
      { key: 'pkg', label: 'package', kind: 'package', required: true },
      { key: 'spec', label: 'probe spec', kind: 'spec', required: true },
    ],
    buildArgv(v) {
      return ['trace', '-P', s(v.pkg), '-F', `${DEVICE_SPECS}/${s(v.spec)}`]
    },
  },
  {
    id: 'lib', label: 'lib (list loaded .so)', engine: 'lib', outputKind: 'stdout',
    inputs: [{ key: 'pkg', label: 'package', kind: 'package', required: true }],
    buildArgv(v) {
      return ['lib', s(v.pkg)]
    },
  },
  {
    id: 'dump', label: 'dump (.so from memory)', engine: 'dump', outputKind: 'artifact',
    inputs: [
      { key: 'pkg', label: 'package', kind: 'package', required: true },
      { key: 'pattern', label: 'pattern', kind: 'pattern', required: true },
    ],
    buildArgv(v) {
      return ['dump', s(v.pkg), s(v.pattern)]
    },
  },
  {
    id: 'mod', label: 'mod (named analyzer)', engine: 'mod', outputKind: 'stdout',
    inputs: [
      { key: 'analyzer', label: 'analyzer', kind: 'analyzer', required: true },
      { key: 'pkg', label: 'package', kind: 'package', required: true },
    ],
    buildArgv(v) {
      return ['mod', s(v.analyzer), '-P', s(v.pkg)]
    },
  },
]

export function capById(id: string): Capability | undefined {
  return CAPABILITIES.find(c => c.id === id)
}

export function validateInputs(cap: Capability, vals: CapValues): string[] {
  const errs: string[] = []
  for (const inp of cap.inputs) {
    if (inp.required && !vals[inp.key]) errs.push(`${inp.label} is required`)
  }
  return errs
}

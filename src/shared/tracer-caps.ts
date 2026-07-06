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
  // Cross-field validation beyond per-input `required` (e.g. syscalls needs a
  // library filter OR capture-all). Returns human-readable errors, [] if valid.
  validate?(vals: CapValues): string[]
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
    // ares rejects `syscalls -P <pkg>` alone: a stack-origin library filter (-l)
    // or capture-all (-a) is mandatory. Enforce it before a run is dispatched.
    validate(v) {
      return v.lib || v.all ? [] : ['provide a library filter or check "capture all libraries"']
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
  if (cap.validate) errs.push(...cap.validate(vals))
  return errs
}

export const DEVICE_BIN = '/data/local/tmp/ares'
export const STOP_ARG = "su -c 'pkill -INT -f /data/local/tmp/ares'"

export function outJsonlPath(ts: string): string {
  return `/data/local/tmp/ares-${ts}.jsonl`
}

// `dump` rebuilds one .so per matching library (named <lib>.<pid>.<addr>.so) into
// a directory (`-d DIR`); the whole directory is pulled after the run.
export function outDumpDir(ts: string): string {
  return `/data/local/tmp/ares-dump-${ts}`
}

// Build the single string handed to `adb shell` as `su -c '<...>'`. One su -c
// per run (chaining breaks BPF load with -EPERM, spec s2). Package/lib/pattern
// tokens are simple identifiers (no quotes/spaces), so plain space-join inside
// the single-quoted su -c body is safe; reject exotic tokens upstream if ever
// needed.
export function composeRunArg(opts: {
  cap: Capability
  vals: CapValues
  timeoutSecs?: number
  jsonlPath?: string
  dumpDir?: string
}): string {
  const argv = opts.cap.buildArgv(opts.vals)
  if (opts.cap.outputKind === 'jsonl' && opts.jsonlPath) argv.push('-o', opts.jsonlPath)
  if (opts.cap.outputKind === 'artifact' && opts.dumpDir) argv.push('-d', opts.dumpDir)
  const inner = opts.timeoutSecs
    ? `timeout -s INT -k 3 ${opts.timeoutSecs} ${DEVICE_BIN} ${argv.join(' ')}`
    : `${DEVICE_BIN} ${argv.join(' ')}`
  return `su -c '${inner}'`
}

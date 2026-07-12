// Capability registry for feature 9 (tracer control). Pure: turns a chosen
// engine + form values into an ares argv. Device paths and the su -c wrapping
// live in composeRunArg (Task 2); this module owns only the per-engine argv.
// Verified against ../ARES src/*/*.c argp tables (see spec s2).

export type OutputKind = 'jsonl' | 'stdout' | 'artifact'
export type InputKind = 'package' | 'text' | 'bool' | 'csv' | 'pattern' | 'spec' | 'analyzer' | 'int'

export interface CapInput {
  key: string
  label: string
  kind: InputKind
  required?: boolean
  default?: number   // int inputs: ares default, shown as placeholder ("use default")
  min?: number       // int inputs: minimum accepted whole number (defaults to 1)
  advanced?: boolean // render inside the collapsible Advanced disclosure
}

export type CapValues = Record<string, string | boolean | undefined>

export interface Capability {
  id: string
  label: string
  engine: string
  outputKind: OutputKind
  loud?: boolean
  // Engine embeds the shared common_args block (-b/-Q/-v). Only syscalls, funcs,
  // and correlate do; drives COMMON_TUNING_INPUTS + commonArgv. trace is jsonl
  // too but hand-rolls its args and takes these only inside sections, so it is
  // deliberately excluded.
  common?: boolean
  inputs: CapInput[]
  buildArgv(vals: CapValues): string[]
  // Cross-field validation beyond per-input `required` (e.g. syscalls needs a
  // library filter OR capture-all). Returns human-readable errors, [] if valid.
  validate?(vals: CapValues): string[]
}

export const DEVICE_SPECS = '/data/local/tmp/specs'

const s = (v: CapValues[string]): string => (typeof v === 'string' ? v : '')

// Shared common_args tuning knobs, appended to every `common` capability. -b/-Q
// are sized in MB; blank means "let ares use its default" (4 / 256).
export const COMMON_TUNING_INPUTS: CapInput[] = [
  { key: 'bufmb', label: 'ring buffer (MB)', kind: 'int', default: 4, min: 1, advanced: true },
  { key: 'queuemb', label: 'worker queue (MB)', kind: 'int', default: 256, min: 1, advanced: true },
  { key: 'verbose', label: 'verbose debug', kind: 'bool', advanced: true },
]

export const CAPABILITIES: Capability[] = [
  {
    id: 'syscalls', label: 'syscalls (stealthy)', engine: 'syscalls', outputKind: 'jsonl', common: true,
    inputs: [
      { key: 'pkg', label: 'package', kind: 'package', required: true },
      { key: 'lib', label: 'library filter', kind: 'text' },
      { key: 'all', label: 'capture all libraries', kind: 'bool' },
      { key: 'syscalls', label: 'syscalls (comma-separated)', kind: 'csv' },
      ...COMMON_TUNING_INPUTS,
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
    id: 'funcs', label: 'funcs (uprobe, detectable)', engine: 'funcs', outputKind: 'jsonl', common: true,
    inputs: [
      { key: 'pkg', label: 'package', kind: 'package', required: true },
      { key: 'spec', label: 'probe spec', kind: 'spec', required: true },
      ...COMMON_TUNING_INPUTS,
    ],
    buildArgv(v) {
      return ['funcs', '-P', s(v.pkg), '-F', `${DEVICE_SPECS}/${s(v.spec)}`]
    },
  },
  {
    id: 'correlate', label: 'correlate (loud)', engine: 'correlate', outputKind: 'jsonl', loud: true, common: true,
    inputs: [
      { key: 'pkg', label: 'package', kind: 'package', required: true },
      { key: 'spec', label: 'probe spec', kind: 'spec', required: true },
      ...COMMON_TUNING_INPUTS,
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

// A capability needs the host specs dir iff it takes a probe spec (funcs /
// correlate / trace). Drives whether the form shows the specs-dir + spec fields.
export function capNeedsSpec(cap: Capability): boolean {
  return cap.inputs.some(i => i.kind === 'spec')
}

// A token is safe to space-join inside the single-quoted `su -c '<...>'` body
// (composeRunArg) only if it carries no shell metacharacter or whitespace: a
// space would split one argument into two, a single quote would close the su -c
// string early (broken command, or injected shell). Allowed: letters, digits,
// and the punctuation that appears in real package/library/spec/syscall tokens.
const SAFE_TOKEN = /^[A-Za-z0-9._:/,+-]+$/
export function isSafeToken(s: string): boolean {
  return SAFE_TOKEN.test(s)
}

// One field's error suffix (label added by the caller), or undefined if valid.
// Shared by validateInputs (dispatch gate) and fieldErrors (per-field UI).
function inputError(inp: CapInput, vals: CapValues): string | undefined {
  const v = vals[inp.key]
  if (inp.required && !v) return 'is required'
  if (inp.kind !== 'bool' && typeof v === 'string' && v && !isSafeToken(v)) {
    return 'has unsupported characters (allowed: letters, digits, and . _ - / : , +)'
  }
  return undefined
}

export function validateInputs(cap: Capability, vals: CapValues): string[] {
  const errs: string[] = []
  for (const inp of cap.inputs) {
    const e = inputError(inp, vals)
    if (e) errs.push(`${inp.label} ${e}`)
  }
  if (cap.validate) errs.push(...cap.validate(vals))
  return errs
}

// Per-field + cross-field errors for the Capture form. `fields` keys are input
// keys (so the UI can place the message under the right control); `form` holds
// the cap-level cross-field errors.
export function fieldErrors(cap: Capability, vals: CapValues): { fields: Record<string, string>; form: string[] } {
  const fields: Record<string, string> = {}
  for (const inp of cap.inputs) {
    const e = inputError(inp, vals)
    if (e) fields[inp.key] = e
  }
  return { fields, form: cap.validate?.(vals) ?? [] }
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

// The host path to pull a capture's JSONL to: the analyst's chosen path if any,
// else the default runs-dir path. Pure so main can stay thin.
export function resolveSavePath(chosen: string | undefined, defaultPath: string): string {
  return chosen && chosen.trim() ? chosen.trim() : defaultPath
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

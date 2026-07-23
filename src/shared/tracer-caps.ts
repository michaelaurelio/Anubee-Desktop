// Capability registry for feature 9 (tracer control). Pure: turns a chosen
// engine + form values into an anubee argv. Device paths and the su -c wrapping
// live in composeRunArg (Task 2); this module owns only the per-engine argv.
// Verified against ../Anubee src/*/*.c argp tables (see spec s2).

export type OutputKind = 'jsonl' | 'stdout'
export type InputKind = 'package' | 'text' | 'bool' | 'csv' | 'pattern' | 'spec' | 'globlist' | 'int'

export interface CapInput {
  key: string
  label: string
  kind: InputKind
  required?: boolean
  default?: number   // int inputs: anubee default, shown as placeholder ("use default")
  min?: number       // int inputs: minimum accepted whole number (defaults to 1)
  advanced?: boolean // render inside the collapsible Advanced disclosure
  // Text inputs default their placeholder to `label`. Set this when the label
  // has to stay short for the caption column but the field needs a format hint.
  placeholder?: string
}

export type CapValues = Record<string, string | boolean | undefined>

export interface Capability {
  id: string
  label: string
  engine: string
  outputKind: OutputKind
  // Engine embeds the shared common_args block (-b/-Q/-v). Drives
  // COMMON_TUNING_INPUTS + commonArgv.
  common?: boolean
  inputs: CapInput[]
  buildArgv(vals: CapValues): string[]
  // Cross-field validation beyond per-input `required` (e.g. syscalls needs a
  // library filter OR capture-all). Returns human-readable errors, [] if valid.
  validate?(vals: CapValues): string[]
}

export const DEVICE_SPECS = '/data/local/tmp/specs'

const s = (v: CapValues[string]): string => (typeof v === 'string' ? v : '')

// Parse an int input value; undefined when blank or non-numeric.
function intVal(v: CapValues[string]): number | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isInteger(n) ? n : undefined
}

// argp accumulates at most 64 -l selectors and warns on the rest (see
// ../Anubee/src/syscalls/syscalls.c, `case 'l'`). Reject past the cap here so
// the analyst sees it in the form instead of in a device log.
export const LIB_SELECTOR_CAP = 64

// A globlist value is stored newline-joined in CapValues (which holds only
// string | boolean | undefined). Newline cannot appear in a selector -
// SAFE_PATTERN rejects it - so no escaping is needed.
export function libList(v: CapValues[string]): string[] {
  if (typeof v !== 'string') return []
  return v.split('\n').map(x => x.trim()).filter(Boolean)
}

// Shared common_args flags for a `common` capability. Emit -b/-Q only when the
// value is set and diverges from anubee' own default (4 / 256) so the argv stays
// minimal and anubee owns the defaults; emit -v when verbose is checked.
export function commonArgv(vals: CapValues): string[] {
  const a: string[] = []
  const b = intVal(vals.bufmb)
  const q = intVal(vals.queuemb)
  if (b !== undefined && b !== 4) a.push('-b', String(b))
  if (q !== undefined && q !== 256) a.push('-Q', String(q))
  if (vals.verbose) a.push('-v')
  return a
}

// Shared common_args tuning knobs, appended to every `common` capability. -b/-Q
// are sized in MB; blank means "let anubee use its default" (4 / 256).
export const COMMON_TUNING_INPUTS: CapInput[] = [
  { key: 'bufmb', label: 'ring buffer (MB)', kind: 'int', default: 4, min: 1, advanced: true },
  { key: 'queuemb', label: 'worker queue (MB)', kind: 'int', default: 256, min: 1, advanced: true },
  { key: 'verbose', label: 'verbose debug', kind: 'bool', advanced: true },
]

// --snapshot: opt-in per-engine flag (syscalls/funcs only). Populates stack_id
// on device, which is what gates inline java_stack - so this toggle is what
// makes a capture reach Java level. Also writes a native <out>.stacks sidecar
// the desktop does not consume (not pulled).
export const SNAPSHOT_INPUT: CapInput = {
  key: 'snapshot',
  label: 'stack snapshots',
  kind: 'bool',
  advanced: true,
}

export const CAPABILITIES: Capability[] = [
  {
    id: 'syscalls', label: 'syscalls', engine: 'syscalls', outputKind: 'jsonl', common: true,
    inputs: [
      { key: 'pkg', label: 'package', kind: 'package', required: true },
      { key: 'libs', label: 'library filters', kind: 'globlist' },
      // Label kept short: at 96px the caption column wrapped it to three lines
      // and left the row ragged. The input's placeholder carries the format.
      { key: 'syscalls', label: 'syscalls', kind: 'csv', placeholder: 'openat,connect (blank = all)' },
      SNAPSHOT_INPUT,
      ...COMMON_TUNING_INPUTS,
    ],
    // No -a: Anubee removed it (commit ad14f98). Absence of every -l selector
    // IS capture-all, so an empty list needs no flag and no validate().
    buildArgv(v) {
      const a = ['syscalls', '-P', s(v.pkg)]
      for (const sel of libList(v.libs)) a.push('-l', sel)
      if (v.syscalls) a.push('-s', s(v.syscalls))
      if (v.snapshot) a.push('--snapshot')
      return a
    },
  },
  {
    id: 'funcs', label: 'funcs', engine: 'funcs', outputKind: 'jsonl', common: true,
    inputs: [
      { key: 'pkg', label: 'package', kind: 'package', required: true },
      { key: 'spec', label: 'probe spec', kind: 'spec', required: true },
      SNAPSHOT_INPUT,
      ...COMMON_TUNING_INPUTS,
    ],
    buildArgv(v) {
      const a = ['funcs', '-P', s(v.pkg), '-F', `${DEVICE_SPECS}/${s(v.spec)}`]
      if (v.snapshot) a.push('--snapshot')
      return a
    },
  },
]

export function capById(id: string): Capability | undefined {
  return CAPABILITIES.find(c => c.id === id)
}

// A capability needs the host specs dir iff it takes a probe spec (funcs).
// Drives whether the form shows the specs-dir + spec fields.
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
  if (inp.kind === 'int') {
    if (typeof v !== 'string' || v.trim() === '') return undefined // blank = use default
    const min = inp.min ?? 1
    const n = Number(v)
    if (!Number.isInteger(n) || n < min) return `must be a whole number >= ${min}`
    return undefined
  }
  if (inp.kind === 'globlist') {
    const list = libList(v)
    if (list.length > LIB_SELECTOR_CAP) return `accepts at most ${LIB_SELECTOR_CAP} selectors`
    // isSafePattern, not isSafeToken: a selector may be a glob (e_*), which
    // isSafeToken rejects. Both still forbid quotes, spaces and $ ` ( ).
    const bad = list.find(x => !isSafePattern(x))
    if (bad) return `selector "${bad}" has unsupported characters (allowed: letters, digits, . _ - / : , + and the globs * ? [ ])`
    return undefined
  }
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

// Runtime gate for tracer:start (main process). The renderer's Capture form
// already calls validateInputs before dispatch, but that is renderer-side
// only - contextIsolation + no nodeIntegration + local file:// content make
// it trusted today, but the composed string is executed as root on the
// device, so the only barrier belongs on the privileged side too. Mirrors
// validateInputs and adds the one field it does not cover: timeoutSecs is
// typed `number` at the IPC boundary but never checked at runtime otherwise,
// and is string-interpolated straight into the command (composeRunArg).
// Returns a human-readable error, or undefined when the request is safe to
// dispatch.
export function validateStartRequest(cap: Capability, vals: CapValues, timeoutSecs: number | undefined): string | undefined {
  const errs = validateInputs(cap, vals)
  if (errs.length) return errs.join('; ')
  if (timeoutSecs !== undefined && !(Number.isInteger(timeoutSecs) && timeoutSecs > 0)) {
    return 'timeout must be a positive whole number of seconds'
  }
  return undefined
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

export const DEVICE_BIN = '/data/local/tmp/anubee'
export const STOP_ARG = "su -c 'pkill -INT -f /data/local/tmp/anubee'"

// Escape ERE metacharacters so a literal string is matched literally by
// `pkill -f` (which takes an extended regex). Package names contain dots;
// unescaped, `dev.anubee.detector` would also match `devXanubeeYdetector`.
export function ereEscape(s: string): string {
  return s.replace(/[.[\]{}()*+?^$|\\]/g, '\\$&')
}

// SIGINT only the live `lib` stream for one package. Anchored with ^ on the
// binary path: the device runs `su -c '<...>'`, and pkill skips itself but not
// its su/sh parent, whose cmdline contains the pattern - but does not START
// with the binary path, so ^ excludes it.
export function stopArgLive(pkg: string): string {
  return `su -c 'pkill -INT -f "^${DEVICE_BIN} lib -P ${ereEscape(pkg)}$"'`
}

// SIGINT only the on-map watcher for one pid. The pattern deliberately stops at
// `--on-map` and never includes the -l glob, so the glob never has to survive a
// round-trip through ERE. pid is digits, so no escaping is needed.
export function stopArgWatch(pid: number): string {
  return `su -c 'pkill -INT -f "^${DEVICE_BIN} dump -p ${pid} --on-map"'`
}

// A dump/on-map glob: SAFE_TOKEN plus the glob metacharacters * ? [ ]. Still no
// quote, $, backtick, space or paren, so it stays safe inside `su -c '...'`.
const SAFE_PATTERN = /^[A-Za-z0-9._:/,+*?[\]-]+$/
export function isSafePattern(s: string): boolean {
  return SAFE_PATTERN.test(s)
}

export function outJsonlPath(ts: string): string {
  return `/data/local/tmp/anubee-${ts}.jsonl`
}

// The host path to pull a capture's JSONL to: the analyst's chosen path if any,
// else the default runs-dir path. Pure so main can stay thin.
export function resolveSavePath(chosen: string | undefined, defaultPath: string): string {
  return chosen && chosen.trim() ? chosen.trim() : defaultPath
}

// A token containing a glob metacharacter must reach anubee literally: the
// device runs `su -c '<inner>'` through sh, which would expand it against the
// device cwd. Wrapping in '\'' closes the outer single quote, emits a literal
// quote, and reopens - the same escape src/main/native-lib-live.ts uses for
// dump's on-map glob. Plain tokens stay bare (SAFE_TOKEN already forbids
// whitespace, quotes, $ and backticks, so they need no quoting at all).
export function needsDeviceQuote(tok: string): boolean {
  return /[*?[\]]/.test(tok)
}

function deviceToken(tok: string): string {
  return needsDeviceQuote(tok) ? `'\\''${tok}'\\''` : tok
}

// Build the single string handed to `adb shell` as `su -c '<...>'`. One su -c
// per run (chaining breaks BPF load with -EPERM, spec s2). Package/lib/pattern
// tokens carry no quotes/spaces (SAFE_TOKEN/SAFE_PATTERN forbid them), so a
// plain token is safe bare; deviceToken additionally quotes any token that
// carries a glob metacharacter, so the device sh cannot expand it.
export function composeRunArg(opts: {
  cap: Capability
  vals: CapValues
  timeoutSecs?: number
  jsonlPath?: string
}): string {
  const argv = opts.cap.buildArgv(opts.vals)
  if (opts.cap.common) argv.push(...commonArgv(opts.vals))
  if (opts.cap.outputKind === 'jsonl' && opts.jsonlPath) argv.push('-o', opts.jsonlPath)
  const body = argv.map(deviceToken).join(' ')
  const inner = opts.timeoutSecs
    ? `timeout -s INT -k 3 ${opts.timeoutSecs} ${DEVICE_BIN} ${body}`
    : `${DEVICE_BIN} ${body}`
  return `su -c '${inner}'`
}

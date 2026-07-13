// Pure leaf-name + duration shaping for the master table's call-site cell.
// No DOM. The full original string stays available for the title-hover tooltip.

const OFFSET = /\+0x[0-9a-fA-F]+$/

// Innermost java method: final '.'-segment, trailing bytecode offset stripped.
export function javaLeaf(fqn: string): string {
  const s = fqn.replace(OFFSET, '')
  const dot = s.lastIndexOf('.')
  return dot >= 0 ? s.slice(dot + 1) : s
}

// Native frame: keep module!symbol, drop the +0x<hex> call-site offset.
export function nativeLeaf(sym: string): string {
  return sym.replace(OFFSET, '')
}

// elapsed_ns -> a compact human duration.
export function formatDuration(ns: number): string {
  if (ns < 1_000) return `${ns} ns`
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(1)} µs`
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(1)} ms`
  return `${(ns / 1_000_000_000).toFixed(2)} s`
}

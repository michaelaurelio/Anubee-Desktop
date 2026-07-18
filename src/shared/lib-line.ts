import type { LibLine } from './native-lib'

// A path may contain spaces; capture it non-greedily up to the ` [0x` range
// marker. Hex ranges/offsets are emitted as 0x-prefixed lowercase. ts_print()
// prepends an optional "HH:MM:SS " timestamp ahead of the "[lib]"/"[unlib]"
// tag on live stdout; both regexes tolerate it without shifting capture
// group indices.
const LIB_RE =
  /^(?:\d{2}:\d{2}:\d{2} )?\[lib\] pid (\d+) (.+?) \[(0x[0-9a-f]+), (0x[0-9a-f]+)\) off=0x([0-9a-f]+) inode=(\d+) ppid=(-?\d+)(?: -> (.+))?$/
const UNLIB_RE = /^(?:\d{2}:\d{2}:\d{2} )?\[unlib\] pid (\d+) \[(0x[0-9a-f]+), (0x[0-9a-f]+)\)$/

// Parse one live-stream stdout line into a LibLine, or null when the line is
// neither a [lib] nor an [unlib] record (e.g. libbpf chatter). Grammar mirrors
// anubee_libtrace_format_lib in ../Anubee/src/common/lib_trace.c.
export function parseLibLine(line: string): LibLine | null {
  const lib = LIB_RE.exec(line)
  if (lib) {
    const out: LibLine = {
      kind: 'lib', pid: Number(lib[1]), library: lib[2],
      start: lib[3], end: lib[4], pgoff: parseInt(lib[5], 16),
      inode: Number(lib[6]), ppid: Number(lib[7]),
    }
    if (lib[8]) out.soname = lib[8]
    return out
  }
  const un = UNLIB_RE.exec(line)
  if (un) return { kind: 'unlib', pid: Number(un[1]), start: un[2], end: un[3] }
  return null
}

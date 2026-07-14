import type { LibLine } from './native-lib'

// A path may contain spaces; capture it non-greedily up to the ` [0x` range
// marker. Hex ranges/offsets are emitted as 0x-prefixed lowercase.
const LIB_RE =
  /^\[lib\] pid (\d+) (.+?) \[(0x[0-9a-f]+), (0x[0-9a-f]+)\) off=0x([0-9a-f]+) inode=(\d+) ppid=(-?\d+)(?: -> (.+))?$/
const UNLIB_RE = /^\[unlib\] pid (\d+) \[(0x[0-9a-f]+), (0x[0-9a-f]+)\)$/

// Parse one live-stream stdout line into a LibLine, or null when the line is
// neither a [lib] nor an [unlib] record (e.g. libbpf chatter). Grammar mirrors
// ares_libtrace_format_lib in ../ARES/src/common/lib_trace.c.
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

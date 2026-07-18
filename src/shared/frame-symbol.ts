// Parse a backtrace `symbol` string into module/symbol/offset.
// Grammar from ../Anubee/src/common/symbolize.c:
//   module!name+0xNN | module+0xNN | [anon]+0xNN | bare 0x<hex> [note]
// `module` may be an APK-embedded path "base.apk -> inner.so" (the " -> " stays).
// `module` is null only for a bare-address (unresolved) frame.

export interface ParsedFrame {
  module: string | null
  symbol: string | null
  offset: number | null
  raw: string
}

export function parseFrameSymbol(s: string): ParsedFrame {
  const raw = s

  // Bare unresolved address: "0x..." (optionally with a "[...]" note), no module.
  if (/^0x[0-9a-fA-F]+/.test(s) && !s.includes('!')) {
    return { module: null, symbol: null, offset: null, raw }
  }

  // Trailing "+0x<hex>" is the offset; strip it before splitting module/symbol.
  let offset: number | null = null
  let body = s
  const off = s.match(/\+0x([0-9a-fA-F]+)$/)
  if (off) {
    offset = parseInt(off[1], 16)
    body = s.slice(0, off.index)
  }

  // "module!symbol" - split on the first "!".
  const bang = body.indexOf('!')
  if (bang >= 0) {
    return { module: body.slice(0, bang), symbol: body.slice(bang + 1), offset, raw }
  }

  // No "!": the body is a module (e.g. "libexample.so" or "[anon]").
  return { module: body, symbol: null, offset, raw }
}

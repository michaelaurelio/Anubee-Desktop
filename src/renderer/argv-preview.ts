// Renders the exact string composeRunArg() will hand to `adb shell`, so a
// capture is never launched blind. Pure DOM (jsdom-testable); the caller owns
// recomputing the argv when the form changes.

const BIN = '/data/local/tmp/anubee'

// Tokenise on spaces only. Values are SAFE_TOKEN/SAFE_PATTERN-checked upstream,
// so none of them contains a space. The surrounding su -c quotes ride along on
// the first and last tokens, but they are wrapper punctuation - emit them
// unstyled, outside the highlighted command and values.
export function renderArgvPreview(host: HTMLElement, argv: string): void {
  host.innerHTML = ''
  const toks = argv.split(' ')
  let i = 0
  const emit = (text: string, cls?: string): void => {
    const el = document.createElement('span')
    if (cls) el.className = cls
    el.textContent = text
    host.appendChild(el)
  }
  while (i < toks.length) {
    if (i > 0) host.appendChild(document.createTextNode(' '))
    const t = toks[i]
    // `<bin> <engine>` reads as one unit: the command being run. The su -c
    // opening quote rides on this token, but it is wrapper punctuation, not
    // part of the command - emit it unstyled so only the command is accented.
    const openQuote = t.startsWith("'") ? "'" : ''
    const bareBin = openQuote ? t.slice(1) : t
    if (bareBin === BIN && i + 1 < toks.length && !toks[i + 1].startsWith('-')) {
      if (openQuote) host.appendChild(document.createTextNode(openQuote))
      emit(`${bareBin} ${toks[i + 1]}`, 'argv-bin')
      i += 2
      continue
    }
    // A value following a flag is the analyst's own input - full contrast.
    // The su -c closing quote rides on the last one; keep it unstyled.
    if (i > 0 && toks[i - 1].startsWith('-') && !t.startsWith('-')) {
      const closeQuote = t.endsWith("'") ? "'" : ''
      emit(closeQuote ? t.slice(0, -1) : t, 'argv-val')
      if (closeQuote) host.appendChild(document.createTextNode(closeQuote))
    } else emit(t)
    i += 1
  }
}

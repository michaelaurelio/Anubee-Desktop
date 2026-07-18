# Testing & GUI review workflow

## Automated tests

```bash
npm test         # vitest: pure logic + DuckDB store + integration (56 tests)
npm run typecheck
npm run build
```

The DuckDB store and integration suites run the real DuckDB (no Electron). The
schema-drift test reads `../Anubee` when present and skips cleanly when it is not.

## GUI screenshot review (giving the agent "eyes")

The renderer is Electron + cytoscape, so unit tests can't see layout, overlap, or
UX problems. We use a **round-trip screenshot loop**: Playwright launches the built
app, drives the renderer, and captures PNGs that a human (or an agent with image
input) reviews - spot a problem, fix the code, re-shoot, compare.

```bash
npm run build            # harness runs the built app in out/
npm run shots            # -> screenshots/01..04 (gitignored)
```

`scripts/screenshot.mjs` captures: loaded master table, a selected focused
subgraph, the node inspector, and a filtered view.

### How it works (and the choices behind it)

- **Playwright `_electron.launch`** runs the built `out/main/index.js` directly -
  the standard way to drive an Electron app end to end.
- **Fixed viewport (1400x900)** so screenshots are stable across runs (a visual-
  regression prerequisite).
- **`ANUBEE_OPEN_FILE` env** auto-loads a run on launch, so the harness never has to
  drive the native file dialog (which automation can't reach). It doubles as a
  real "open a file from the CLI" affordance.
- **Deterministic node clicks:** the renderer exposes the cytoscape instance as
  `window.__cy`; the harness reads a node's rendered position and clicks it,
  instead of guessing pixel coordinates (a center-of-canvas click hits empty
  space and misses every node).
- **Headless/WSL:** WSLg supplies `DISPLAY`; the harness passes `--no-sandbox`
  `--disable-gpu` for the Electron zygote. The Electron binary must be downloaded
  (`node node_modules/electron/install.js`) if a sandboxed `npm install` skipped
  the postinstall.

### Reviewing

Open `screenshots/*.png` (or hand them to an image-capable agent) and be picky:
label/edge overlap, truncated columns, inconsistent zoom, contrast, alignment.
Fix the renderer, re-run `npm run shots`, and diff the before/after.

## References

- Playwright - Electron class (`_electron.launch`, `window.screenshot`):
  https://playwright.dev/docs/api/class-electron
- Electron - Automated testing with Playwright:
  https://www.electronjs.org/docs/latest/tutorial/automated-testing
- Simon Willison, "Testing Electron apps with Playwright and GitHub Actions":
  https://til.simonwillison.net/electron/testing-electron-playwright
- Agentic Coding Handbook - Visual Feedback Loop:
  https://tweag.github.io/agentic-coding-handbook/WORKFLOW_VISUAL_FEEDBACK/

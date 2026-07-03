# ARES-Desktop

Cross-platform (Windows + Linux) desktop apps for [ARES](https://github.com/michaelaurelio/ARES) tracing tools.
Renders the **syscall → native → Java** call-chain mapping so an analyst can see
which block of a custom native library implements a given RASP behavior (root /
debugger / emulator / integrity / hook detection) and which app-package Java
method reached it.

## Prerequisites

- **Node.js** + **npm** (Electron v42 toolchain).
- A native build toolchain for the **DuckDB** native module (rebuilt for
  Electron's ABI via `electron-builder install-app-deps`).
- Optional: a sibling checkout of the **ARES** tracer at `../ARES` — only needed
  to run the schema-drift test that guards the JSONL contract. Tests skip that
  check when `../ARES` is absent.

## Build

```bash
npm install      # postinstall rebuilds the DuckDB binding for Electron
npm run dev      # launch the app
npm test         # unit + integration (vitest)
npm run typecheck
```

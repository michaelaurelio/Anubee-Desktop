# Anubee-Desktop

Cross-platform (Windows + Linux) desktop apps for [Anubee](https://github.com/michaelaurelio/Anubee) tracing tools.
Renders the **syscall → native → Java** call-chain mapping so an analyst can see
which block of a custom native library implements a given RASP behavior (root /
debugger / emulator / integrity / hook detection) and which app-package Java
method reached it.

## Prerequisites

- **Node.js** + **npm** (Electron v42 toolchain).
- A native build toolchain for the **DuckDB** native module (rebuilt for
  Electron's ABI via `electron-builder install-app-deps`).

## Build

```bash
npm install      # postinstall rebuilds the DuckDB binding for Electron
npm run dev      # launch the app
npm test         # unit + integration (vitest)
npm run typecheck
```

## MCP server

A TypeScript MCP server in `tools/anubee-mcp-ts/` lets an MCP client drive a
running app (requires MCP control to be enabled in the app). See
[tools/anubee-mcp-ts/README.md](tools/anubee-mcp-ts/README.md).

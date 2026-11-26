# Anubee-Desktop

[![License: GPLv2](https://img.shields.io/badge/License-GPLv2-blue.svg)](LICENSE)

Electron desktop apps for [Anubee](https://github.com/michaelaurelio/Anubee) tracing tools.
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

### 1. Build the server

```bash
cd tools/anubee-mcp-ts
npm install
npm run build        # tsc -> dist/index.js
```

### 2. Register it with your MCP client

Claude Code:

```bash
claude mcp add anubee -- node /<path-to-directory>/Anubee-Desktop/tools/anubee-mcp-ts/dist/index.js
```

Other clients (JSON config):

```json
{
  "mcpServers": {
    "anubee": {
      "command": "node",
      "args": ["/<path-to-directory>/Anubee-Desktop/tools/anubee-mcp-ts/dist/index.js"]
    }
  }
}
```

### 3. Enable MCP control

Start the app, click **MCP** in the left rail, and switch
**Allow AI control (MCP)** to **On**.

See [tools/anubee-mcp-ts/README.md](tools/anubee-mcp-ts/README.md) for the full
tool list.

## License

See [LICENSE](LICENSE).

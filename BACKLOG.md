# ARES-Desktop - backlog / next-session guide

Log here: features shipped with a known drawback to resolve later, deferred work,
and open verification items. Newest concerns first.

## Open verification items (before / during Phase 1)
- **Renderer GUI not yet run** (Tasks 8-9) - IPC wiring, master table, and the
  focused-subgraph render are typechecked + built but not exercised in a live
  Electron window (no display in the build env). Manual `npm run dev` verify is
  pending: File > Open a fixture -> table lists rows -> selecting a bridge draws
  the java->native->syscall subgraph -> filters reshape the table.
- **ELK runs on the main thread** (Task 9, via `cytoscape-elk`), not a Web Worker
  as spec §5.1 describes. Acceptable for Phase 1 because the slice cap keeps the
  graph small (fast layout). If the cap is raised materially, move layout to the
  elkjs Web-Worker build + feed positions to cytoscape as a `preset` layout so a
  large layout never freezes the window.
- **Node-click inspector** (done Task 10) - `GraphStore.nodeEvents(nodeId, filter)`
  + `graph:nodeEvents` IPC + preload + `cy.on('tap','node')` are wired and
  unit-tested (store side). Still part of the pending live-GUI verify above.

- **DuckDB native module in Electron** - confirm `@duckdb/node-api` packages and
  runs on **both Windows and Linux** via `electron-builder` (`asarUnpack` the
  native binding; `postinstall: electron-builder install-app-deps` for the ABI
  rebuild). This is the one real packaging risk in the new data tier.
  - **Status (Task 1):** `@duckdb/node-api@1.5.4` loads + queries fine under
    **Node 22** (smoke-tested). NOT yet exercised under **Electron** - first real
    Electron+DuckDB run is Task 6/8. `electron-builder` is not installed yet
    (packaging is a later phase), so the `postinstall` ABI-rebuild hook is
    deferred; add it when packaging lands and re-verify the binding against
    Electron's ABI then.
- **Ingest progress + cancel granularity** - in-main `read_json` gives coarse
  progress (DuckDB progress callback / byte estimate) and interrupt-based cancel.
  If that feels bad on a multi-GB run, fall back to ingest-in-a-worker with a
  DuckDB **file** handoff (worker writes, main opens read-only). Plan Task 8 /
  spec §5.
- **Slice-cap value** - start at ≤1–2k nodes/edges (spec §5.1). Tune against a
  real busy run once fixtures exist; the truncation banner must trigger before
  cytoscape/ELK degrades.
- **Schema-drift test robustness** - `tests/schema-drift.test.ts` scrapes quoted
  keys from `../ARES/src/syscalls/syscalls.c`. If the emitter is refactored to
  build keys non-literally, the scrape breaks - revisit to parse `trace_schema.h`
  instead. Test must skip cleanly when `../ARES` is absent.

## Deferred features (post-core, spec §7)
- **5** RASP semantic tagging + heuristic pre-tagging → brings `project-store`
  sidecar persistence.
- **6** Findings export (Markdown/JSON).
- **7** Run diffing - implement as a **SQL join over two ingested DuckDB runs**
  (the DuckDB tier makes this cheap; note it when scheduling).
- **9** Tracer control over adb (offline-friendly launch → capture → auto-load).
- **11** Flame-graph / icicle view - strong companion for the call-chain *depth*
  axis; DuckDB supplies the stack rollup. Node-link graph stays for the
  cross-links / bridges.
- **8** Session-only MCP (stdio) exposing the tagged graph. Decision C: headless
  analytics + device tools stay in `tools/ares-mcp`.
- **10** Timeline view / live-stream input-swap - needs ordered/live data.
- **Supernode aggregation + drill-down** - a whole-run overview (module/class
  supernodes, expand on demand) beyond the core table→focused-subgraph path.

## Render-engine escape hatches (only if a *filtered* view outgrows cytoscape+ELK)
- Layout axis: **Graphviz `dot` via `@hpcc-js/wasm`** (faster/higher-capacity
  than elkjs, in a worker).
- Render axis: **G6 v5** (WebGL + built-in layered layout, one lib) or
  **sigma.js + graphology** (WebGL, fed precomputed positions).
- These are for the *view*; the data ceiling is DuckDB's job, already handled.

## Superseded (kept for context)
- The original Phase-1 plan built an **in-memory `ARESGraph`** and `postMessage`d
  the whole parsed-event array worker→main. Replaced 2026-07-03 by the DuckDB
  store (spec §5) because that path OOMs V8 on multi-GB runs and re-scans every
  event per filter. Do not reintroduce a full in-heap event array.

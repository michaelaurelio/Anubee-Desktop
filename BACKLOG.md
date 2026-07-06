# ARES-Desktop - backlog / next-session guide

Log here: features shipped with a known drawback to resolve later, deferred work,
and open verification items. Newest concerns first.

## Shipped in Phase 2 (features 5, 6, 7)
- **5** RASP semantic tagging + heuristic pre-tagging - `project-store` sidecar
  persistence (`<run>.ares-desktop.json`), tag editor + node badges + table tag
  column, bounded DuckDB candidate scan feeding a pure `score()` (three grounded
  rules: ptrace `args[0]==0`, root-path openat/access/newfstatat/faccessat,
  `/proc/self/status` read), Confirm-to-tag flow.
- **6** Findings export (Markdown/JSON) - `src/shared/findings.ts` builds one
  `Finding` per tag (native block, category, calling Java method, syscall+path,
  occurrence count); export dialog writes the file.
- **7** Run diffing - the `ev` table is now `run_id`-scoped (multiple runs
  loaded at once); `diffTable` (full-outer-join of per-run node counts ->
  presence + delta) and `diffSlice` (merged, colored neighbourhood) implemented
  in `GraphStore`, with a renderer diff mode (load run B -> A/B/delta table ->
  select row -> merged colored subgraph).

## Known drawbacks from Phase 2 (to resolve later)
- **`diffSlice` neighbourhood scoping** - it reuses the full per-run `slice()`
  then trims to the selected node's immediate neighbourhood; a deliberate
  simple first cut, but can be broad (and slow) on a very large run. Revisit if
  it's a problem on real busy runs.
- **emulator / integrity / hook heuristic rules are stubs** - the categories
  exist (`RaspCategory`) but `rasp-heuristics.ts` only scores `debugger` and
  `root` today; no reliable syscall-only signal identified yet for the other
  three.
- **Ptrace-request SQL/schema coupling** (mental note for the next ARES-version
  bump) - `rasp-heuristics.candidateWhere()`'s SQL pre-filter matches the
  ptrace request as raw `args[1] IN ('0x0', '0')`, which couples to ARES's
  current hex-emit format (`jb_hex` always emits `"0x0"` for request 0). If
  ARES ever emits decoded/decimal request values instead, this SQL pre-filter
  would silently narrow candidates below what the pure `score()` would catch -
  the arg *formatting* is not covered by `tests/schema-drift.test.ts` (which
  only checks field names). Re-check this predicate whenever the vendored ARES
  schema version is bumped.
- **Phase 2 close-out (2026-07-06)** - diffSlice now honors the active filter;
  orphaned-tag detection + Drop repair UX; ELK layout moved to a Web Worker
  (cytoscape gets a preset layout); the four code-review minors are closed.

## Open verification items (before / during Phase 1)
- **Renderer GUI verified** (via `npm run shots`) - table, focused subgraph, node
  inspector, and the has-java_stack filter all work end to end in a live Electron
  window. Open UI polish from that review (see below).
- **UI polish from the first GUI review** (FIXED, verified via `npm run shots`):
  1. Master table - fixed column layout with ellipsis + `title` tooltips; no more
     horizontal scrollbar.
  2. Graph node labels moved beside the node (right-aligned, light backing) so the
     edge/arrow no longer crosses them; target arrows scaled down + lightened.
  3. `cy.fit(padding)` after layout - consistent framing per selection.
  4. Inspector record links restyled (no default underline), detail separated.
  - Remaining minor: single vertical chains leave empty space to the right (labels
    extend right, nodes sit left-of-center) - acceptable; revisit if it bothers.
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
  - **Status (GUI run):** RESOLVED for dev - `@duckdb/node-api@1.5.4` ingests +
    queries fine **under Electron 42** (the live app loaded the fixture, and the
    table/slice/inspector all pulled from DuckDB). Packaging (`electron-builder`
    `asarUnpack` + ABI rebuild) is still unproven for a distributable build.
  - **(historical) Task 1:** loaded + queried under **Node 22** first; the first
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

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

## Shipped this session (flame-graph view + graph polish)
- **11** Flame-graph / icicle view - `GraphStore.stackRollup` (reuses
  `CHAIN_SQL`, `GROUP BY chain`) -> `buildFlame` prefix-tree fold
  (`src/shared/flame-shape.ts`) -> hand-rolled SVG icicle
  (`src/renderer/flame-view.ts`): top-down, kind-colored, click-to-zoom, hover
  tooltip, truncation banner. Toggled via Graph/Flame buttons in the toolbar.
  **Caps validated (2026-07-06)** against a real 245,760-event run: the caps
  now live in `src/shared/caps.ts` (`GRAPH_SLICE_CAP` 1500, `FLAME_CHAIN_CAP`
  5000, `FLAME_NODE_CAP` 2000). Measured on the real run: flame tree = 12,347
  nodes unfiltered, so `FLAME_NODE_CAP` truncates and the flame banner **was
  observed to fire** in a live window; the graph banner was verified by
  forcing a low cap (real focused subgraph is only ~152 elements, so the
  graph cap is a safety ceiling the per-row path never reaches). Fixed a live
  bug found here: the renderer passed `undefined` as the graph slice cap, so
  the graph banner could never fire.
- **P1** Graph node legend - always-visible shape/color key in the graph pane
  (`#legend`), reused verbatim by the flame view's `KIND_FILL` map.
- **P2** Master table column widths - `top java` / `top native` columns
  widened (96px / 110px) so typical entries show more of the name before
  eliding.

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
- **`runElkLayout` surfaces no layout error** - if the elkjs worker fails to
  spawn/bundle on a target platform, `runElkLayout` rejects and the graph
  silently fails to lay out (nodes stay at the origin) with no user feedback.
  Matches the renderer's existing no-try/catch pattern; add a catch + status
  message if this ever bites. Verified working via `npm run shots`.
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
    Centering the chain (`centerNodesX`) was attempted this session and
    reverted: shifting nodes toward center clips the right-side node labels
    (they extend ~300px, wider than the ~540px graph pane), so full-label
    visibility was kept over centering. Accepted as a cosmetic known-minor.
- **ELK layout in a Web Worker** (RESOLVED 2026-07-06, Phase 2 close-out) -
  previously ran synchronously on the main renderer thread via `cytoscape-elk`.
  Now runs in the elkjs Web-Worker build (`elk-api` + `elk-worker.min.js` via
  Vite's `?worker`), feeding positions to cytoscape as a `preset` layout;
  `cytoscape-elk` removed. A large layout no longer freezes the window.
- **Node-click inspector** (done Task 10) - `GraphStore.nodeEvents(nodeId, filter)`
  + `graph:nodeEvents` IPC + preload + `cy.on('tap','node')` are wired and
  unit-tested (store side). Still part of the pending live-GUI verify above.

- **DuckDB native module in Electron** - confirm `@duckdb/node-api` packages and
  runs on **both Windows and Linux** via `electron-builder` (`asarUnpack` the
  native binding; `postinstall: electron-builder install-app-deps` for the ABI
  rebuild). This is the one real packaging risk in the new data tier.
  - **Status (2026-07-06):** RESOLVED on **Linux**. `electron-builder@26.15.3`
    added; `package.json` `build` block `asarUnpack`s `@duckdb/**` and
    `postinstall: electron-builder install-app-deps` rebuilds the binding
    against the Electron 42 ABI (clean). `npm run dist` (`--linux dir`) emits
    `release/linux-unpacked/`; the **packaged** app was driven against a real
    245,760-event run and all three DuckDB paths served from the unpacked
    binding (master table 501 rows, focused slice, node-inspector raw record).
  - **Remaining: Windows packaging still unproven** (deferred - no Windows
    target reachable this session). Re-verify `asarUnpack` + ABI rebuild there.
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
- **Slice-cap value** - RESOLVED (2026-07-06). Centralized in
  `src/shared/caps.ts` and validated against a real 245,760-event run: the
  focused-subgraph path peaks at ~152 elements, so `GRAPH_SLICE_CAP` 1500 sits
  well below the ~2-3k cytoscape/ELK hairball threshold and acts as a safety
  ceiling; both truncation banners were observed to fire in a live window
  (flame naturally at 12,347 tree nodes, graph via a forced low cap). Retune
  only if a future run shows focused subgraphs approaching the ceiling.
- **Schema-drift test robustness** - `tests/schema-drift.test.ts` scrapes quoted
  keys from `../ARES/src/syscalls/syscalls.c`. If the emitter is refactored to
  build keys non-literally, the scrape breaks - revisit to parse `trace_schema.h`
  instead. Test must skip cleanly when `../ARES` is absent.

## Shipped this session (feature 9 - tracer control)
- **9** Tracer control over adb (launch → capture → auto-load) - `tracer-caps`
  capability registry (7 engines, three output kinds jsonl/stdout/artifact),
  `tracer-control` main orchestration (preflight, `startRun` with per-stream
  `lineSplitter`, graceful `pkill -INT` stop, `pullResult`), config persistence
  (`<userData>/tracer-config.json`), and the renderer **Capture** view. Full
  detail in `DOCUMENTATION.md`. **Device-verified 2026-07-07** (stock
  `com.android.deskclock`): syscalls 81,611 events ingested; lib 91 `[lib]` lines;
  dump 5 rebuilt `.so` pulled; both timeout and manual-stop paths flush the sink.

### Known drawbacks / follow-ups from feature 9
- **`dump` dumps on app *exit* by default** (post-decryption) - the capability
  does not expose `--on-map` (dump-the-instant-a-lib-maps) or `-p <pid>`
  (attach to a running process). For a short UI window the on-exit default
  relies on the app exiting or the timeout firing. Add `--on-map` / attach-pid
  as dump options if a real use needs a mid-run dump.
- **`mod` analyzer is a free-text field** - the analyzer name is typed by the
  user, not discovered from `ares mod --help`. Parse the analyzer list at
  runtime when this is exercised on device (spec §9 open item).
- **`funcs`/`correlate`/`trace` spec is a free-text filename** - the UI expects
  a spec basename under the pushed `specs/` dir; it does not list the available
  specs. These JSONL engines were not exercised on-device this session (only
  `syscalls`, `lib`, `dump` were); smoke them when a spec-driven run is needed.
- **stdout/artifact runs never send a UI "run loaded" signal** - only `jsonl`
  runs auto-switch to the table; `lib`/`dump` leave the result in the console /
  `userData/runs/` with no in-app artifact browser yet.

## Deferred features (post-core, spec §7)
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

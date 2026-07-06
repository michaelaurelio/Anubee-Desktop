# ARES-Desktop - technical documentation

Technical breakdown of the app, per feature. Kept current on confirmed change.

## How it works

Offline-first: you load a saved ARES JSONL run. The run is ingested into an
embedded **DuckDB** store in the app's main process - raw records stay in the
database, off the JS heap, so multi-GB runs don't blow up memory. Navigation is
through a filterable **master table**; selecting a bridge of interest renders its
**focused syscall→native→Java subgraph**. The app never draws a whole run at once:
a graph slice is filtered and capped before it reaches the renderer.

- **Data tier** - DuckDB in the main process (`@duckdb/node-api`). `read_json`
  ingest; SQL answers the master table, a capped graph slice, and raw records by
  id. The ingest schema and queries are ported from the ARES host-side DuckDB
  store (`../ARES/tools/ares-mcp`); no Python runtime is bundled.
- **Render tier** - a master table for the full run, then cytoscape.js + ELK
  (layout in a Web Worker) for the focused subgraph. An over-large slice is
  truncated with a prompt to narrow the filter, never drawn as a hairball.
- **Pure logic** - Electron-free, unit-tested modules own the event schema, the
  backtrace-symbol grammar, and the node/edge identity rules.

## Limitations (Phase 1)

- **Offline only** - loads a saved JSONL file; no live streaming, no on-device
  capture yet (tracer control and live view are later phases).
- **Focused views, not a whole-run graph** - you reach a subgraph by filtering the
  table and selecting a row. A whole-run overview (supernode aggregation) and a
  flame-graph view are deferred.
- **Rendered slices are capped** - an over-large graph slice is truncated with a
  prompt to narrow the filter, rather than drawn as an unreadable hairball.
- **Input contract is ARES JSONL output only** - the app parses ARES's output
  schema; it never builds against ARES source.

## Phase 2 - tagging, heuristics, findings export, run diffing

Phase 2 turns the read-only Phase 1 viewer into an annotation and comparison
tool, built on the same DuckDB data tier. Four features:

### Run-scoped store (multiple runs loaded at once)

The single DuckDB `ev` table gained a `run_id` column, and `GraphStore` keeps an
in-memory run registry (`RunInfo`: run id, source file, ingest timestamp, event
count) alongside an "active" run id. `ingest()` assigns each loaded file the
next run id and appends into the same table rather than replacing it, so a
second `Load run` call does not evict the first. Every query method (table,
slice, `nodeEvents`, `suggest`) defaults to the active (most-recently-loaded)
run when no run id is passed, so Phase 1 call sites keep working unmodified.
This run-scoping is what makes run diffing (below) possible without a second
DuckDB instance.

### RASP semantic tagging

An analyst marks a graph node (or a specific offset inside it) with what RASP
behavior it implements. A tag (`src/shared/project-store.ts`, type `Tag`) has:

- `target` - a graph node id: `nat:<mod>!<sym>` (native symbol), `java:<method>`,
  `sys:<name>` (syscall), or `edge:<src>=><target>`.
- `offset` (optional) - a block-level refinement, e.g. `libexample.so+0x1234`,
  chosen from a concrete backtrace frame in the node inspector when a symbol
  covers more than one basic block.
- `category` - one of `root | debugger | emulator | integrity | hook | custom`.
- `source` - `manual` (analyst-authored) or `heuristic` (confirmed from a
  suggestion, see below), plus `confidence`/`rationale` when heuristic-sourced.

Tags persist to a sidecar file next to the loaded run, `<run>.ares-desktop.json`
(`src/main/sidecar.ts`), so tagging survives across sessions without mutating
the trace itself. `project-store.ts` is pure (parse/validate/serialize/upsert -
no filesystem access); main reads and writes the file. A malformed sidecar
entry is dropped with a reported error rather than failing the whole load.
Identity for upsert/remove is `(target, offset)` - retagging the same target at
the same offset replaces, not duplicates. The renderer exposes a tag editor in
the node inspector and shows tag badges on graph nodes plus a tag column in the
master table (`src/renderer/tag-view.ts`, `inspector.ts`).

### Orphaned tags

When a sidecar is loaded against a re-ingested run whose node ids have shifted
(symbol resolution differs, binary rebuilt), tags whose target no longer matches
any node/edge become orphans. `GraphStore.orphanTargets(targets, runId?)` reports
which targets are absent (node-id and edge-key sets built in main so only the tag
targets cross IPC); the pure `orphanedTags(tags, orphanSet)` selects them and the
renderer's Orphans panel lists each with a Drop / Drop all action. Orphans are
never dropped automatically - the analyst confirms.

### Heuristic pre-tagging (never auto-applied)

`src/shared/rasp-heuristics.ts` scores individual syscall events against three
rules grounded in ARES's actual (undecoded) output shape:

1. `ptrace` with raw `args[0] == 0` (`PTRACE_TRACEME`) -> `debugger`.
2. `openat` / `access` / `newfstatat` / `faccessat` touching a known root
   indicator path (`su`, `magisk`, `/system/xbin`, `/sbin`) -> `root`.
3. `read` of `/proc/self/status` (a common `TracerPid` check) -> `debugger`.

`emulator`, `integrity`, and `hook` are declared categories with no reliable
syscall-only signal yet - they exist in the type so a later rule can slot in,
but ship as stubs today. `GraphStore.suggest(runId?)` narrows the scan with
`candidateWhere()`, a SQL predicate built from the same rule constants (in
particular `SUSPICIOUS_PATH_PATTERN`) as the pure `score()` function, so only
genuine candidates are reconstructed onto the JS heap - `score()` remains the
scoring authority, the SQL predicate is purely a bounded pre-filter. Matching
events are aggregated per target (`aggregate()`: sums occurrences, keeps the
highest-confidence rationale) into `Suggestion` rows (target, category,
confidence, rationale, occurrence count) and listed in a suggestions panel
(`src/renderer/suggestions-view.ts`). A suggestion is never turned into a tag
automatically - the analyst reviews it and clicks Confirm, which mints a
`source: 'heuristic'` tag through the same tag editor path.

### Findings export

`src/shared/findings.ts` is a pure module: `buildFindings(tags, reps)` joins
each confirmed tag to a representative syscall event for that target (the
calling Java method from `java_stack[0]`, the syscall, the path/fd it hit, and
an occurrence count) into a `Finding`. `renderMarkdown()` and `renderJSON()`
render the finding list for hand-off to a report; an export dialog in the
renderer writes the chosen format to disk.

### Run diffing

`GraphStore.diffTable(runA, runB, filter?, cap?)` computes per-run node-id
occurrence counts (`nodeCounts()`, a `chainOf`-equivalent SQL unnest + group-by
scoped to one run and the active filter) for both runs, then a full-outer-join
by node id into `DiffRow` (id, kind, label, countA, countB, delta, presence:
`A-only | B-only | both`), ordered divergence-first (A-only / B-only before
shared), then by descending `abs(delta)`. `GraphStore.diffSlice(runA, runB,
nodeId, filter?)` instead takes each run's `slice()` under the same active
filter as the table, merges the node/edge sets (tagging each with the same
`presence` classification), and trims the merged graph down to the
neighbourhood of the selected node. The renderer's diff mode (`diff-view.ts`):
load a second run -> an A/B/delta table filterable by only-in-A / only-in-B /
tagged -> select a row -> a merged subgraph colored red (removed, A-only),
green (added, B-only), grey (shared).

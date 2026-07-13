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
  table and selecting a row. A whole-run overview (supernode aggregation) is
  deferred; the flame-graph view (below) covers the call-depth axis instead.
- **Rendered slices are capped** - an over-large graph slice is truncated with a
  prompt to narrow the filter, rather than drawn as an unreadable hairball.
- **Input contract is ARES JSONL output only** - the app parses ARES's output
  schema; it never builds against ARES source.

### Graph node legend

The focused subgraph draws a small always-visible legend in the bottom-left of
the graph pane (`#legend` in `index.html`): a green diamond for a java method, a
blue dot for a native symbol, a red square for a syscall - the same shape/color
coding used on the nodes themselves and reused verbatim by the flame view's
`KIND_FILL` map (`src/renderer/flame-view.ts`) so the two views read as one
system.


## Funcs engine support

The app loads both `ares syscalls` and `ares funcs` output. A run's engine is
detected at ingest from the record types present (`RunInfo.kinds`); the left
panel and graph adapt automatically. A funcs run traces native function
entry/exit via uprobes: each hooked call emits a `call` record (entry, args,
backtrace) and a `return` record (retval, `elapsed_ns`) that **share one `id`**
(a monotonic per-call span counter the tracer emits on both).

- **Funcs list.** For a funcs run the master table lists one row per `call`,
  with columns `function` (`module!symbol`), `caller` (the immediate native
  frame, offset stripped), `retval`, `elapsed`, and `args`. retval/elapsed are
  folded from the matching `return` by a deterministic join on the shared `id`
  (`GraphStore.table()`), so recursion and reentrancy pair correctly; a call
  with no return shows blank. `return` records are not listed.

- **Funcs call graph.** Selecting a row draws a **deep, unified
  function-to-function call graph**, built entirely in SQL (`FUNCS_CHAIN_SQL`)
  and verified against the pure-TS oracle `foldFuncEvents` by a lockstep test.
  The chain is the whole reversed backtrace (plus reversed `java_stack` when a
  capture carries it). Managed frames collapse by method: the ART bytecode
  offset (`+0x<dexpc>`) is stripped from `java:` ids exactly as native call-sites
  collapse by their dropped `+0x<off>`, so one managed method is one node whether
  it was AOT-compiled (no offset) or interpreted (carries a dexpc). A backtrace
  frame whose `module!symbol` is itself a
  hooked function collapses into that function's own `fn:` node (unify), so a
  function appears once whether it is a leaf or a caller; unhooked intermediate
  frames stay `nat:` scaffold nodes. Nodes reuse the `func` kind (gold) in the
  same visual language as the syscall graph.

```mermaid
flowchart TD
  JNI["nat: JNI_OnLoad (unhooked)"] --> CR["fn: checkRoot"]
  CR --> GP["fn: getProp"]
  CR --> OP["fn: open"]
```

Funcs and syscall graphs share common `nat:` native nodes by identity, so a
mixed `trace` run (both engines) renders one organic native call graph rather
than two disconnected islands. Funcs chains, list, and count all carry the
`span IS NULL` guard, so span-tagged correlate rows never leak in.

- **Funcs record inspector.** Clicking a funcs graph node lists the `call`
  records whose chain touches it (`# · caller · retval · elapsed · args`); clicking
  a list row - or a master-table row - opens that record's full detail (function,
  tid, caller, retval, `elapsed_ns`, then `args`, `string_args`, `fd_args`,
  `sock_args`, `out_args`, and the backtrace). A displayed record is the `call`
  row merged with `retval`/`elapsed_ns`/`out_args` from its paired `return` (shared
  `id`), joined in SQL by `GraphStore.eventById` / `nodeEvents` (engine-routed,
  bounded, `span IS NULL`). The ghidra offset popup is syscall-only for now, so
  node-tap skips it on a funcs run.

## UI shell

The toolbar is a single **chrome bar** housing a **File ▾** dropdown (Open JSONL,
Capture, Export Markdown, Export JSON, Log, Quit), the active run pill, the segmented
Graph/Flame view switch, Rules, Suggestions, Export ▾ / Diff ▾ menus, and the
theme toggle. The native Electron menu is removed; all navigation flows through
the File dropdown and toolbar actions. A dedicated **filter bar** sits below the
chrome bar. Capture, Rules, and Suggestions open as **centered modal overlays**
(shared `src/renderer/modal.ts` component) that do not consume side-panel space;
the table and graph remain visible behind the modal and modals are dismissed by
an explicit Close button or by clicking outside. An empty state is shown in place
of the body until a run is loaded.

### Activity log (File ▾ Log)

Every user **action** is recorded to an in-memory activity log - run load, export,
capture + streamed tracer output, rule updates, tag edits, preflight - each an
entry with a level (`info` / `success` / `warn` / `error`). Read-queries (table,
graph slice, node records) are not logged. **File ▾ Log** opens a modal with a
scrollable, color-coded monospace **terminal box** that live-appends while open
(auto-scrolling when pinned to the bottom) and renders entry text with
`textContent` only (tracer output is untrusted). **Save** writes the buffer to a
chosen `ares_<YYYYMMDD>_<HHMMSS>.log` file via a native save dialog; **Clear**
empties it. The log is the source of truth for process outcomes: it replaced the
old always-visible status pill (removed). The pure `src/renderer/log-store.ts`
(ring-capped at 5000 entries) is the single state owner; `src/renderer/run-logged.ts`
wraps each action to log success/error; `src/renderer/log-view.ts` renders the modal.

**Ingest progress** (formerly on the status pill) now shows as a thin progress bar
on the **empty-state** during a run's first load, driven by the tracer/ingest
`onProgress` events and hidden once the run loads.

### Master table and detail panels

The body is split into a left **master table** and a right **detail panel**, both
conditionally visible:

- **Master table** appears only after a run is loaded. It displays all events
  matching the current filter, paginated at 500 rows per page with a header pager
  (`‹ from–to / total ›`) to step prev/next over the full result - the pager
  header carries the page window and the filtered total. Applying a filter or
  loading/switching a run resets to page 1.

- **Detail panel** appears only when a record or graph node is selected. It has
  two modes:
  - **Row selection:** clicking a master-table row opens a single-record detail
    (Summary / Args / Java stack / Backtrace) AND still redraws the middle graph
    slice to reflect that row's subgraph.
  - **Graph-node selection:** clicking a graph node opens the records-behind-node
    list (unchanged from earlier phases).

The detail panel is dismissed via an explicit X button in its header; the master
table is collapsed/expanded via a floating square button at the table's right edge
(or far left when collapsed).

### Master table columns

The master table's columns are **configurable**. Default set: `id · syscall · top java · top native · args · tags`.

- **Column picker:** a `⚙ columns` button in the table header opens a modal with
  a checkbox per column (with `id` locked on). The chosen set persists to
  `localStorage` under key `ares.columns`, so column preferences survive an app
  restart.

- **Column definitions:**
  - `id` - event id (locked on).
  - `syscall` - the syscall name.
  - `top java` - the innermost Java method in the event's `java_stack` (or `-`
    if no Java).
  - `top native` - the innermost native symbol in the event's backtrace
    (or `-` if syscall-only).
  - `args` - the primary argument, computed by precedence in the DuckDB
    `table()` SQL query: resolved string arg > fd path > decoded arg > raw arg.
    Disambiguates which file/path/resource the syscall touched.
  - `tags` - RASP tags on the row's innermost native frame (`topNative` node id,
    offset dropped). Tags live on native library nodes; a syscall row shows a
    badge only when its innermost native frame carries a tag. Multiple tags
    render as a comma-separated badge list.

- **Engine-aware picker.** The column set and the `⚙ columns` picker are chosen
  by the run's engine (`columnCatalogue` / `columnsForEngine`): a funcs run offers
  only funcs columns (`id · function · caller · retval · elapsed · args`), a
  syscall run only syscall columns. Toggles persist per engine under
  `ares.columns.<engine>` (the legacy `ares.columns` key is still read as the
  syscall fallback), so a saved funcs layout and a saved syscall layout coexist.

- **Column widths:** each column width is keyed by column name (not position), so
  any subset of columns lays out correctly. Text-heavy columns (`top java`,
  `top native`, `args`) share the remaining width after fixed columns; the panel
  is resizable, and widths are clamped per-column for readability. At the default
  ~420px table width, the text columns truncate (mitigated by resize + `title`
  tooltip on hover + full detail in the right-panel record view).

### Adjustable panels

The table and side (graph/flame/capture) regions are drag-resizable and
collapsible. Pure width math (`clampWidth`, `DEFAULT_LAYOUT`, `parseLayout`/
`serializeLayout`) lives in `src/renderer/panels.ts` and is unit-tested;
`wirePanels` does the DOM wiring in the renderer. Widths are held as CSS custom
properties (`--table-w` / `--side-w`), clamped to 160-760px, and resizing is
driven by **window-level** pointer listeners rather than listeners on the drag
handle itself, so a drag that outruns the handle (fast mouse movement) doesn't
drop the resize. The master table collapses/expands via a floating square button
positioned just outside the table's right edge (or far left when collapsed); the
right panel is dismissed via its header X button only (no collapse affordance).
Both the widths and the collapsed/expanded state persist to
`localStorage['ares.layout']`, so the layout survives an app restart.

**Known limitation:** persistence is per-machine (`localStorage`), not
per-project - opening the same run on a different machine does not carry over
the saved layout.

### Theme

`src/renderer/theme.ts` defines a token-based theme system: CSS custom
properties with a dark default, toggled to light via a ☾/☀ button in the
chrome bar, persisted to `localStorage['ares.theme']`. Critically, `theme.ts`
is the **single source** of the java/native/syscall (plus label-backing and
edge) colors - `applyGraphTheme` feeds them to cytoscape, the `#legend`, and
the flame view's `kindFill`, replacing the previously triplicated color
constants that had drifted across those three call sites. The graph's label
backing color switches with the theme so node labels stay legible against
both the dark and light canvas.

### Graph zoom

A zoom cluster (`+` / `-` / fit) sits over the graph pane, driving `cy.zoom`
and `cy.fit` directly - there was previously no way to zoom the focused
subgraph other than the mouse wheel.

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

`src/shared/rasp-heuristics.ts` is a **rule-driven** engine, not a hardcoded
scorer. A `Rule` is data:

```
{ id, category, confidence, rationale, enabled,
  match: { syscalls, field, op, argIndex?, value }, source }
```

`field` is one of the event's own shapes (`args`, `string_args`, `fd_args`,
`sock_addr`); `op` is a **fixed** operator vocabulary - `path_matches` (regex
against a path-like field), `equals`, `arg_hex_eq` (hex-normalized arg
comparison) - so a rule is pure declarative matching, never user SQL or code.
That fixed vocabulary is the safety boundary: anyone (a project, a user
library) can add a rule, but no rule can execute arbitrary logic.

Two compilers consume the same rule set and are kept in lockstep by a
real-DuckDB integration test:

- `compileWhere(rules)` -> a bounded SQL `WHERE` clause, used as a candidate
  pre-filter so `GraphStore.suggest(runId?)` only reconstructs genuine
  candidates onto the JS heap.
- `scoreWith(rules, ev)` -> the per-event JS predicate and **scoring
  authority**; the SQL pre-filter is purely a bounded narrowing, never the
  source of truth for what matches.

Every suggestion is attributed to the innermost **non-system** native frame
(`nativeTargetOf`) - the app's own RASP block (e.g.
`base.apk -> libsentinel.so!sentinel_check_root`), skipping the bionic / ART /
framework wrappers; it falls back to the innermost native frame (the libc
syscall wrapper) only when the whole native path is system libs (a pure-Java
check). Matching events are aggregated per target (`aggregate()`: sums
occurrences, keeps the highest-confidence rationale) into `Suggestion` rows
(target, category, confidence, rationale, occurrence count) and surfaced in a
**Suggestions popup** opened from the chrome-bar button
(`src/renderer/suggestions-view.ts`); the right side panel stays details-only. A
suggestion is never turned into a tag automatically - the analyst clicks
**Confirm** (mints a `source: 'heuristic'` tag through the tag editor path) or
**Reject** (persists a dismissal in the sidecar `dismissed` list so it never
returns); either removes the row.

**Built-in rules** (`BUILTIN_RULES`):

| id | syscalls | field / op / value | category | conf |
|---|---|---|---|---|
| `dbg-ptrace-attach` | ptrace | args / arg_hex_eq[0] / `0x10` | debugger | 0.7 |
| `dbg-ptrace-traceme` | ptrace | args / arg_hex_eq[0] / `0x0` | debugger | 0.9 |
| `dbg-status-open` | openat, newfstatat | string_args / path_matches / `/proc/self/status$` | debugger | 0.6 |
| `dbg-status-read` | read | fd_args / equals / `/proc/self/status` | debugger | 0.6 |
| `hook-maps` | openat, newfstatat | string_args / path_matches / `/proc/self/maps$` | hook | 0.5 |
| `hook-frida-sock` | connect | sock_addr / path_matches / `frida` | hook | 0.9 |
| `root-paths` | openat, access, newfstatat, faccessat | string_args / path_matches / `su`, `magisk`, `busybox`, `/system/xbin`, `/sbin`, `/data/adb` | root | 0.85 |
| `root-selinux` | openat, newfstatat, faccessat | string_args / path_matches / `/sys/fs/selinux/enforce$` | root | 0.8 |
| `root-ksu-prctl` | prctl | args / arg_hex_eq[0] / `0xdeadbeef` | root | 0.9 |

`emulator` and `integrity` ship **no built-in rule** and are not
syscall-detectable: emulator checks are typically property reads
(`__system_property_get`, not a syscall), and integrity checks read the app's
own `base.apk`, which is indistinguishable from ordinary DEX/zip loading at the
syscall layer. Both remain valid `RaspCategory` values for manual tagging.

**Merge across scopes.** Rules resolve from three layers: `BUILTIN_RULES`, a
global library (`<userData>/rasp-rules.json`, `rasp-rules-store.ts`), and a
per-project override carried in the run's `<run>.ares-desktop.json` sidecar.
`resolveRules` concatenates builtin -> global -> project and, on an `id`
collision, **later scope wins** (project overrides global overrides builtin).
`enabledOverrides` lets any scope enable/disable any rule by id under the same
later-scope-wins precedence, so a project can re-enable a rule a user has
globally disabled.

### RASP rule-authoring UI

A `#rules` floating panel (`src/renderer/rules-view.ts`, opened by the "Rules"
toolbar button) lists `resolveRules`' effective set as **card rows** (aligned with
the Suggestions modal visual language), each displaying a category chip, source
`[builtin|global|project]` badge, rule id, confidence + syscalls count, and the
predicate line (field / op / value). Each card row has an aligned trailing
enabled/disabled toggle, Edit / Delete (writable scopes) / Reset (builtins)
actions; every action reads the raw stored global/project scope (not the merged
effective list), mutates a copy, and calls `rasp:rules:save`.

The editor is a single-stacked predicate-builder form (`id`, `category`,
`confidence`, `rationale`, `syscalls`, `field`, `op`, `argIndex` - shown only
when `op` is `arg_hex_eq` - `value`) plus an explicit scope radio (Global |
Project) that is independent of the row being edited. `draftFromForm`/
`validateRule` reject an invalid draft inline before anything reaches IPC.

**Editing a builtin forks it.** Builtins are read-only in `BUILTIN_RULES`;
saving an edit to a builtin row writes a same-`id` rule into whichever scope
the form's scope radio has selected, and `resolveRules`' later-scope-wins
merge makes that shadow rule take over from the builtin at read time. Reset
reverses this: it deletes the same `id` from *both* global and project scopes
(`deleteRule` x2), so the row falls back to the plain builtin. The builtin
row's enable-toggle works similarly - it doesn't flip a flag on the
builtin (there is none to flip); it writes an `enabledOverrides` entry into
the project (run-local) scope, which `resolveRules` applies at read time.

**Live preview.** While the form is open, every field edit (debounced ~250ms)
revalidates the draft and, if valid, calls `rasp:rules:preview` ->
`GraphStore.previewRule(runId, rule)`: a bounded DuckDB scan that runs
`compileWhere([rule])` as the candidate pre-filter, scores each candidate with
`scoreWith`, and reports `{ events, targets }` - the count of events with a
hit and the count of distinct native targets those hits resolve to - rendered
as `matches N events → M targets`. An invalid rule or no loaded run returns
`{ error }`, shown in place of the counts. The preview never writes anything;
it exists purely so an analyst can gauge a draft rule's blast radius against
the current run before saving it into global or project scope.

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

## Flame-graph view

A second view mode alongside the focused subgraph, toggled with the Graph /
Flame buttons in the toolbar (`#tab-graph` / `#tab-flame`, `showView()` in
`main.ts`): an icicle over every chain in the current filter, for reading call
*depth* rather than the graph's cross-link structure.

- **`stackRollup` (data tier)** - `GraphStore.stackRollup(filter, maxChains,
  runId?)` (`src/main/graph-store.ts`) reuses the same `CHAIN_SQL` chain
  expression as the graph slice query, but groups by the whole chain instead of
  by adjacent edge: `SELECT chain, count(*) FROM (SELECT <CHAIN_SQL> AS chain
  FROM ev WHERE <scoped filter>) GROUP BY chain ORDER BY c DESC LIMIT
  <maxChains>`. It also reports `eventCount` and `distinctChains` (unfiltered by
  the row cap) so the renderer can tell "5000 chains shown" from "5000 chains,
  period." `maxChains` defaults to 5000 and bounds the IPC payload; rows beyond
  the cap are dropped (heaviest first), not silently merged.
- **`flame-shape` fold (pure tier)** - `buildFlame(rows, cap)`
  (`src/shared/flame-shape.ts`) folds the distinct weighted chains into a
  prefix tree under a synthetic `root` node (heaviest chains inserted first, so
  a node `cap` - the renderer passes 2000 - keeps the hottest paths and stays
  deterministic regardless of input order). Each tree node's `value` is the
  summed count of every chain passing through it; `labelForId` (shared with the
  graph's `nodeFromId`) supplies the same `{kind, label}` per node id, so a
  syscall/native/java frame in the flame reads identically to the same node in
  the graph. `layoutFlame(root, width, rowHeight)` then does the icicle math:
  root spans the full width at the top, each node's children partition its
  parent's width in proportion to `value`, and depth grows downward.
- **Hand-rolled SVG icicle (render tier)** - `renderFlame(host, tree,
  truncated)` (`src/renderer/flame-view.ts`) draws `layoutFlame`'s rects as
  plain SVG `<rect>`/`<text>` elements, no charting library. Top-down (root at
  y=0, deeper frames below), kind-colored via the same `KIND_FILL` map as the
  graph legend (root grey, java green `#27ae60`, native blue `#2980b9`, syscall
  red `#c0392b`), truncated labels with a rough char-budget-per-pixel so text
  never spills its box. Clicking a frame with children re-roots the view on it
  (zoom); a `⤴ reset` button returns to the full tree. Hovering a frame shows a
  native `<title>` tooltip with the full label, absolute count, and percentage
  of the current root's total - no JS tooltip library, works fully offline. A
  truncation banner (`.flame-banner`) appears whenever either cap actually
  cut data (`rollup.truncated || tree.truncated`).
- **Limitation** - the flame is a *filtered* rollup, capped at 5000 chains
  (`stackRollup`) and 2000 tree nodes (`buildFlame`), same principle as the
  graph slice cap: never draw an unbounded run at once. If the banner appears,
  narrow the filter (has-java_stack, syscall, tid, ...) to see every path
  rather than a heaviest-first sample.

## Render caps (`src/shared/caps.ts`)

The three render-tier caps live in one module - `GRAPH_SLICE_CAP` (1500),
`FLAME_CHAIN_CAP` (5000), `FLAME_NODE_CAP` (2000) - consumed by the renderer's
graph and flame paths. They were validated against a real 245,760-event
capture: the per-row focused subgraph peaks at ~152 elements (so the graph cap
is a safety ceiling below the ~2-3k cytoscape/ELK hairball threshold, not a
routine limit), while the unfiltered flame folds to 12,347 tree nodes and
truncates at `FLAME_NODE_CAP` - the flame truncation banner was observed to
fire in a live window, the graph banner via a forced low cap.

## Packaging (`electron-builder`, Linux verified)

The one native-module packaging risk is `@duckdb/node-api`. `package.json`'s
`build` block `asarUnpack`s `@duckdb/**` so the binding loads from
`app.asar.unpacked/` at runtime, and `postinstall: electron-builder
install-app-deps` rebuilds it against the Electron ABI. `npm run dist`
(`electron-vite build && electron-builder --linux dir`) produces
`release/linux-unpacked/`. The packaged app was driven against a real run and
served the master table, focused slice, and node-inspector raw records all
from the unpacked DuckDB binding. Windows packaging is not yet verified.

Note: the `files: ["out/**"]` entry only narrows the *app source* electron-builder
packs; it does **not** drop `node_modules` - electron-builder collects production
dependencies (including `@duckdb/node-api`) separately, so the binding is still
bundled and then `asarUnpack`ed. Do not "correct" `files` to add `node_modules`.

## Tracer control (feature 9) - launch → capture → auto-load

Launch the ARES tracer on a connected rooted device from the **Capture** view,
capture its output, and route the result back in. Offline-friendly: the tracer
writes to a device file during the run; the desktop pulls and ingests it after
the run stops (not a live-streaming graph - that is feature 10).

**Modules.** `src/shared/tracer-caps.ts` (pure) is the capability registry - one
descriptor per engine with a `buildArgv`, cross-field `validate`, and the
`composeRunArg` device-command builder. `src/main/tracer-control.ts` (main) owns
the adb orchestration behind an injected `Adb`/`Spawner` seam: `preflight`,
`startRun` (spawn + per-stream line buffering via `lineSplitter`), `stop`,
`pullResult`. `src/renderer/capture-view.ts` renders an aligned-field form +
bordered console (unified visual language with Rules and Suggestions modals);
the toolbar wiring lives in `main.ts`'s `wireCapture()`.

**Capture form layout and save destination.** The form collects engine, target
package, engine-specific arguments, timeout, and a `syscalls` field. The
**`syscalls` field is a comma-separated FILTER** (not a save format) - it
narrows which syscalls are captured when relevant to the engine (e.g. only
`openat,read` events); capture output is always JSONL regardless. At the bottom,
an aligned **"save to" host-path field** with a Browse button lets the analyst
choose where the pulled JSONL is written. Browse fires the `tracer:pickSavePath`
IPC, which opens a native Save dialog (defaulting to a `capture.jsonl` file) and
fills the field. On Start, the field value is passed to `tracer:start`, where the
pure `resolveSavePath(chosen, default)` uses it when non-empty, else falls back to
the default `<userData>/runs/ares-<ts>.jsonl`; the device capture is pulled to
that path and loaded.

**Capabilities and the three output kinds.** All seven engines are exposed.
`syscalls`/`funcs`/`correlate`/`trace` are `jsonl` (`-o <dev>.jsonl` → pull →
reuse the existing `loadPath` ingest → switch to the master table). `lib` is
`stdout` (streams `[lib]` lines to the console). `dump` is `artifact`. `mod`
runs a named analyzer (default `stdout`). `correlate`/`trace` carry a
"writes BRK" loud badge.

**The `su -c` contract.** Each ares run is one `su -c '<single string>'` -
chaining commands in one `su -c` breaks the on-device BPF load with `-EPERM`.
Runs are wrapped `timeout -s INT -k 3 <secs>` for a graceful SIGINT stop with a
SIGKILL backstop; the manual Stop button sends `pkill -INT -f …ares` as a
separate `su -c`. A blank timeout means "run until Stop". User-entered tokens
(package/library/pattern/spec/syscalls) are space-joined into that single-quoted
body, so `validateInputs` (and the preflight entry) reject any value carrying a
shell metacharacter or space - only `[A-Za-z0-9._:/,+-]` is admitted - before a
run is dispatched.

**Preflight** gates Start with five ordered checks (device reachable, `su`
root, kernel BTF, package installed, on-device binary md5 vs the configured host
`build/ares` - pushed if stale, after `kill_ares` to avoid `ETXTBSY`). Host
paths to `build/ares` + `specs/` persist in `<userData>/tracer-config.json`.
Each check streams to the renderer as it completes (`tracer:preflight-check`,
one event per `PreflightCheck`) rather than arriving as a single batch after
the whole sequence finishes, so the status list fills in row by row while the
device is queried. The push branch is guarded against an unconfigured host
*before* any `adb push`: an unreadable/empty host binary (md5 `''`) fails the
`binary` check with an explanatory detail instead of shelling out - the
binary is always required and always pushed when stale. The **host specs
dir is optional** - only the spec engines (`funcs`/`correlate`/`trace`) use
it. An empty `specsDir` is *skipped*, not failed: the binary push proceeds
regardless, and the specs push (`mkdir -p` + `push .../.`) runs only when
`cfg.specsDir` is set, closing the earlier `adb push /.` (whole host
filesystem) hazard from an empty-string path expansion.

**Capture form layout, path validation, and Browse pickers.** The modal is a
sectioned form - "1. host setup", "2. engine & arguments", "3. run" - each
introduced by a numbered `.cap-section-hd` header, replacing the earlier
single-stacked layout. Host setup carries only the ares binary field, with a
Browse button (`tracer:pickBinary` opens a native open-file dialog) and a
validity dot fed by `tracer:checkPaths` → `path-check.ts`'s pure `isElf`
(checks the file's first four bytes for the ELF magic number); the dot
repaints on every path edit and after each Browse pick. Engine and argument
fields, the timeout, and the host binary field all render per-field inline
errors under an adjacent `.cap-input-err` span, populated from `fieldErrors`
as the analyst types - no more silent rejection at Start. The engine dropdown
lists each capability's plain `engine` name. The loud-engine warning banner
was removed entirely from the form (no in-form loud cue remains); the `loud`
flag survives only as unused data in `tracer-caps.ts`. The renderer's
preflight click handler wraps the `tracer:preflight` IPC call in a try/catch:
if the call rejects, the handler now reports a `preflight-bad` row with an
informative "preflight failed: <message>" status (no longer frozen on
"running preflight...") and Start remains disabled after a failure - the
original failure mode before this guard was added.

**Optional specs dir + probe-spec discovery.** The specs-dir field no longer
lives in host setup - it moved into the engine section, gated by
`capNeedsSpec(cap)` (`tracer-caps.ts`, true iff a capability has a `spec`
input), so `syscalls`/`lib`/`dump`/`mod` never render it and only the three
spec engines do. For those engines, `renderCapabilityForm` (`capture-view.ts`)
renders the specs-dir row directly above the probe-spec control, with its own
Browse (`tracer:pickSpecsDir`) and validity dot (`hasSpecFile` - at least one
`.spec` entry in the directory listing). The probe-spec input itself renders
as a `<select>` dropdown, not free text: `tracer:listSpecs` (`src/main/index.ts`)
→ `path-check.ts`'s pure `specNames` lists the `.spec` basenames (sorted) found
in the configured specs dir, and `applySpecChoices` repopulates the dropdown's
options in place whenever the specs dir changes - so editing that field never
rebuilds or refocuses the rest of the form. Because the dir is optional,
Start for a spec engine is still gated on it being set and non-empty via the
existing `hasSpecFile` validity check, even though preflight itself no longer
requires it.

**Engine-specific arg rules learned from the device.** `syscalls` rejects
`-P <pkg>` alone - a library filter (`-l`) or capture-all (`-a`) is mandatory,
enforced by `syscalls`'s `validate` before dispatch. `dump` rebuilds one `.so`
per matching library (named `<lib>.<pid>.<addr>.so`) into a directory (`-d DIR`);
the handler creates the device dir up front and pulls the whole directory.

**Advanced tuning flags.** A collapsible **Advanced** section on the capture form
exposes three ares runtime flags for the `syscalls`, `funcs`, and `correlate`
engines (the three that embed ares' shared `common_args` block): `-b` (ring buffer
in MB, ares default 4), `-Q` (worker queue in MB, ares default 256), and `-v`
(verbose debug output). A blank field means use the ares default; a flag is
emitted only when the value diverges from the default. Note: JSONL framing (`-J`)
is not a form control - it is guaranteed because every capture's output path ends
in `.jsonl`, which ares treats as newline-per-record framing.

**Stack snapshots (`--snapshot`).** The Advanced section on `syscalls` and `funcs`
engines includes a stack-snapshots toggle (opt-in, default off). When enabled, it
populates the on-device `stack_id` field, which gates inline `java_stack` delivery
- a capture reaches Java-level backtrace only when this toggle is on. The toggle
applies to `syscalls` and `funcs` only (the two engines ARES accepts `--snapshot`
on). Note: enabling the toggle also writes a native `<out>.jsonl.stacks` sidecar
(the full ordered CFI walk per `stack_id`, each frame `kind`-tagged) alongside the
pulled `.jsonl`. The desktop **consumes** this sidecar: on ingest it is loaded into
the store beside the run, and any event whose `stack_id` has a `cfi_stack` record
has its call-graph chain built from that ordered walk (recovering the true
managed↔native interleaving and the outer-native caller the frame-pointer
backtrace stops short of) instead of the `java_stack` + FP-backtrace concatenation.
Events without a sidecar record fall back to the concatenation unchanged. See the
graph node identity notes above; the cfi path reuses the same `java:`/`nat:`/`fn:`
grammar so cfi- and fallback-derived nodes coalesce.

**Storage + privacy.** Pulled captures land in `<userData>/runs/` (outside the
repo); the target package is user-entered at runtime, never hardcoded.

**Device-verified (2026-07-07).** Against a real rooted device (stock
`com.android.deskclock`): preflight all-green; `syscalls -a` → 81,611 events
ingested, 0 parse errors; graceful timeout stop (exit 124) and manual `pkill -INT`
stop (exit 130) both flushed the sink; `lib` → 91 `[lib]` lines with `libc.so`
resolved; `dump` → 5 rebuilt `.so` files pulled from the dump directory.

## Native-block origin mapping - instruction offsets within native frames

Locates concrete instruction addresses within native symbols by computing
module-relative offsets from the ARES `lib` module-map records. The offset is the
difference between the frame address and its module's load base (`addr - load_base`),
which maps back into a ghidra-opened binary's image-base-relative offset for
symbol-level drill-down and binary-level annotation.

**Module map.** The ARES tracer's `lib` stdout lines record every library's load
base per (pid, basename) when the tracer first observes it. The desktop `GraphStore`
indexes these into a module map (`src/main/graph-store.ts`, `moduleById`). A
`nodeOffsets` query on a native node computes the concrete offset for each event
via `addr - load_base`; unmapped events (no matching lib record) are marked
`[unmapped]` and show no offset, allowing analysts to identify frames missing from
the tracer's library map.

**Node selection and tagging.** Clicking a native node highlights its fan-in/out
neighbourhood, fills the right inspector panel with the node's filtered syscall
records (via `nodeEvents` - the syscalls whose backtraces target that node), and
opens an offset popup positioned to the right of the node; the popup flips to the
left at the viewport edge via the pure `placePopup` layout helper. Clicking a
syscall or Java node fills the inspector with the selected node's records only,
with no offset popup. Each syscall record in the inspector is rendered as
**sectioned cards** (Summary, Args, Java stack, Backtrace) rather than a flat
text dump, grouping related details for readability. Tagging is now a single path:
right-click any node to open a context menu (Copy / Add Tag), select Add Tag to open
a themed floating tag popup (`showTagPopup`), and confirm to save. Inline tag editors
were removed from the offset popup and inspector; `renderTagEditor` is re-themed onto
CSS shell tokens.

**Offset popup.** The offset popup displays a scrollable table of per-call-site
instruction offsets: each row represents one `(offset, syscall)` pair, showing the
offset (hex), the count of events at that offset making that specific syscall, and a
label showing the syscall name. Right-click a row for Copy (to paste into a hex
editor or ghidra search bar) or Copy-as-JSON (for programmatic handling). The offset
column is clickable to reveal the exact per-offset event (raw backtrace, syscall, args,
etc.) via a store-provided sample event id, feeding the analyst's reasoning about
what the address does. Rows marked `[unmapped]` indicate that the offset could not
be resolved - see "Module map and unmapped offsets" below.

**Module map and unmapped offsets.** Offsets resolve to ghidra image-base addresses
only when the run carries `lib` records, which the ARES tracer emits whenever it
observes an executable module load (mmap) during the trace. A **snapshot** or
post-load capture (e.g. `ares syscalls --snapshot <pkg>`) has no `lib` records,
because the modules were already loaded when tracing began. In such cases, every
offset shows `[unmapped]` and tagging (offset-scoped drill-down) is not available.
To resolve offsets: **capture from process start** (before the app loads its libraries),
or work with a tracer-side change to prime the module map from `/proc/<pid>/maps` at
attach time. Once `lib` records are available, the desktop re-ingests the same `.jsonl`
file and computes offsets from the module load bases.

**Fan-in/fan-out selection highlight.** Selecting a graph node highlights its
neighbourhood: syscall nodes show fan-in only (incoming Java calls); Java nodes
show their entire subtree (Java callees + native frames + syscalls they invoke);
native nodes show both directions (calling Java methods + reached syscalls). Nodes
outside the selected path dim to background, drawing focus on the caller-callee
chain. Edges in the selected path are highlighted in brighter, thicker strokes
(`width` 3.5, full-strength `labelText` color, `arrow-scale` 1.3) to clearly
illuminate the entire call chain from the selected node outward. This is the
**litNeighborhood** highlight, distinct from the earlier whole-graph coloring.

**RASP category coloring on native blocks.** When a native node is tagged with a
RASP category (debugger, root, hook, etc.), the node's box gains a visual marker
- a dashed category-color border for `suggested` (heuristic not yet confirmed) and
a solid category-color border for `confirmed` (analyst-approved tag). Coloring lives on the
**native node itself**, not on the aggregate syscall node above it, because a
suggestion targets the innermost non-system native frame (the app's own block);
the syscall node aggregates all calls through all native intermediaries, so its category would
conflate unrelated calls. The master table and flame view reserve a badge marker
on the Java/syscall nodes; native-scoped categories are visible only on the graph.

**Node-box redesign.** The graph's node rendering changed from draggable circles
with separate labels to a uniform **non-draggable** design: rounded-rectangle
boxes with a 2px border accent in the node's `kind` color (green for Java, blue
for native, red for syscall), or the RASP category border when tagged (dashed
for suggested, solid for confirmed) and the label text rendered inside the box,
truncated to approximately 22 characters with ellipsis (full text visible in the
offset popup header and node inspector). Boxes are laid out by ELK and do not
respond to drag; the uniform border reduces visual noise and avoids
label-backing conflicts. The layout respects label width via ELK's `width:
'label'` sizing hint; see Limitations below.

**Limitations**
- The offset aggregation caps at 5000 events per node (spec §14.1), so very hot
  nodes may under-report offset diversity and reach-chip counts with no visible
  truncation signal.
- APK-embedded modules (e.g. `base.apk -> libinner.so`) do not match the module
  map's basename key and get no offset.
- Unload/reload of the same library at a different base address (rare in the
  traced scope but theoretically possible) uses the global lowest base and mis-maps
  events after the reload.

**Phase 2 deferrals.**
- Per-call-site drill-down canvas nodes (`nat:module@0xVADDR`) with a two-level
  graph-shape identity change to support true per-offset navigation.
- Cross-selection bolding (select an offset → bold all the syscalls it reaches
  across the graph).
- Session-MCP `origins(syscall | tag)` query for programmatic offset inspection.
- "Open in ghidra" staging to launch ghidra with the module and offset pre-loaded.

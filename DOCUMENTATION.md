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

### Master table column widths

The master table's `top java` / `top native` columns are widened (96px / 110px,
`#table td:nth-child(5)` / `nth-child(6)` in `index.html`) so a typical
`com.example.app.Class.method` / `libexample.so!symbol` entry shows more of the
name before eliding, on top of the existing ellipsis + `title` tooltip fallback.

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

Every suggestion is attributed to the nearest native frame (`nativeTargetOf`).
Matching events are aggregated per target (`aggregate()`: sums occurrences,
keeps the highest-confidence rationale) into `Suggestion` rows (target,
category, confidence, rationale, occurrence count) and listed in a suggestions
panel (`src/renderer/suggestions-view.ts`). A suggestion is never turned into a
tag automatically - the analyst reviews it and clicks Confirm, which mints a
`source: 'heuristic'` tag through the same tag editor path.

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
toolbar button) lists `resolveRules`' effective set with a `[builtin|global|
project]` source badge per row, an enable/disable checkbox, and Edit /
Delete (writable scopes) / Reset (builtins) actions - every action reads the
raw stored global/project scope (not the merged effective list), mutates a
copy, and calls `rasp:rules:save`.

The editor is a predicate-builder form (`id`, `category`, `confidence`,
`rationale`, `syscalls`, `field`, `op`, `argIndex` - shown only when `op` is
`arg_hex_eq` - `value`) plus an explicit scope radio (Global | Project) that
is independent of the row being edited. `draftFromForm`/`validateRule` reject
an invalid draft inline before anything reaches IPC.

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
`pullResult`. `src/renderer/capture-view.ts` renders the form + console; the
toolbar wiring lives in `main.ts`'s `wireCapture()`.

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
separate `su -c`. A blank timeout means "run until Stop".

**Preflight** gates Start with five ordered checks (device reachable, `su`
root, kernel BTF, package installed, on-device binary md5 vs the configured host
`build/ares` - pushed if stale, after `kill_ares` to avoid `ETXTBSY`). Host
paths to `build/ares` + `specs/` persist in `<userData>/tracer-config.json`.

**Engine-specific arg rules learned from the device.** `syscalls` rejects
`-P <pkg>` alone - a library filter (`-l`) or capture-all (`-a`) is mandatory,
enforced by `syscalls`'s `validate` before dispatch. `dump` rebuilds one `.so`
per matching library (named `<lib>.<pid>.<addr>.so`) into a directory (`-d DIR`);
the handler creates the device dir up front and pulls the whole directory.

**Storage + privacy.** Pulled captures land in `<userData>/runs/` (outside the
repo); the target package is user-entered at runtime, never hardcoded.

**Device-verified (2026-07-07).** Against a real rooted device (stock
`com.android.deskclock`): preflight all-green; `syscalls -a` → 81,611 events
ingested, 0 parse errors; graceful timeout stop (exit 124) and manual `pkill -INT`
stop (exit 130) both flushed the sink; `lib` → 91 `[lib]` lines with `libc.so`
resolved; `dump` → 5 rebuilt `.so` files pulled from the dump directory.

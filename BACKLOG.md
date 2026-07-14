# ARES-Desktop - backlog / next-session guide

Log here: features shipped with a known drawback to resolve later, deferred work,
and open verification items. Newest concerns first.

## Shipped (2026-07-15) - Native Libraries (lib + dump)

A third view mode (Libraries, next to Graph/Flame) with a Loaded-run <-> Live-device
source switch and a collapsible bottom artifacts dock. Loaded mode reads retained
`type:lib`/`unlib` records via `GraphStore.libTable` (unlib flags unmapped frames).
Live mode streams `ares lib -P <pkg>` stdout parsed by `src/shared/lib-line.ts`,
stamping each library with host arrival time and flagging post-setup loads (after
`NEW_LIB_SETTLE_MS`, 1500ms) as `new` - the packer-decrypt signal. Dumping attaches
to the live pid (`ares dump -p <pid> <pattern>`), pulls the output dir + manifest,
and triages each `.so` via `src/shared/elf-triage.ts` (ELF magic/arch/sha-256/size).
Reveal opens the file manager; Export saves a copy. `lib` and `dump` are no longer
selectable engines in the Capture modal.

### Known drawbacks / follow-ups
- Loaded-mode `new-since-start` is not shown (no wall-clock in the `lib` JSONL); the badge is live-mode only. Loaded rows show ingest sequence.
- soname is taken from the `lib` record / dump manifest module name, not parsed from the dumped ELF's `DT_SONAME`.
- Packer-proof hash-vs-on-disk compare is deferred (needs also pulling `/data/app/.../lib/<abi>/<name>.so`).
- Live stream + dump use the default adb device; multi-device `-s` selection is deferred (matches the rest of the app).
- Two concurrent ares processes (lib stream + `dump -p`) are unverified on device; if they conflict, stop the stream for the dump then resume. `dump -p` acceptance by ares' argp is a device-verify item.
- `startLive` has no double-start guard: invoking it while a stream is live orphans the previous RunHandle (the renderer hides Start after click, so low risk today).
- Live-stream and dump stdout share the single `nativelib:line` IPC channel; lines interleave if a dump is fired mid-stream.
- The Libraries view re-fetches `libTable` on every tab click (cheap - lib records are sparse); the omni filter bar still renders in the Libraries view though it only drives the (hidden) syscall master table.
- Pre-existing (not introduced by this feature): the `#tab-left` collapse float button clips the leading text of the Flame view's truncation banner, the same overlap the Libraries header fix resolved for its own view.
- GUI smoke was via `npm run shots` against the loaded fixture (`10-libraries.png`); the live-stream + dump path needs an on-device pass.

## Shipped (2026-07-14) - omni filter bar

The command bar's filter is now a single free-text input with a `key:value`
grammar (`syscall:`, `lib:`, `tid:`, `java:yes|no`, `module:`, `symbol:`)
that turns into removable chips, plus key-name autocomplete. Free text now
also searches all arg fields (`args`, `string_args`, `fd_args`,
`decoded_args`, `sock_args`, `out_args`), not just syscall name and stacks.
Full detail in `DOCUMENTATION.md`'s "UI shell" section.

### Known drawbacks / follow-ups
- Omni filter bar shipped with known limits: single value per key (no OR
  within one key - needs Filter/SQL changes), key-name autocomplete only (no
  value suggestions from the loaded run), and no negation/regex grammar.
- java-bearing row selection builds its slice filter via free text (`filterForRow` sets `f.text` to the top java frame), and free text now also searches arg fields - a slice can pick up unrelated events whose args contain the method substring; consider a dedicated java-frame filter field.
- `module:` / `symbol:` chips on a syscall-engine run yield an empty table with no cue that these keys are funcs-only.
- Autocomplete list goes stale on caret-only movement (ArrowLeft/Right); multi-token Enter re-renders chips once per token. Cosmetic.
- One cold-start full-suite flake (1/448, not reproduced in 5 reruns) observed during final review - watch next session.

## Shipped (2026-07-14) - UI/UX round 2: chips, detail panel, fonts, theme toggle, project bundle

A visual-consistency + portability pass over the round-1 shell. One unified
`.cat-chip` category-chip component (`categoryColors` in `theme.ts`, mirrored
to `--cat-*` CSS tokens) now backs the master table's tag column, the
Suggestions modal, the Rules modal, and the redesigned detail-panel header;
the Rules modal's enable/disable control is a sliding toggle switch (not a
checkbox), dimming a disabled row to 55% opacity. The detail panel
(`inspector.ts`) got a kind-dot + kind-colored name + record-count-pill
header, a sticky records table (kind-colored syscall cell, red negative
retval, accent-barred selected row), accent-barred detail cards, and a
backtrace that highlights the app's own innermost non-system frame
(`appFrameIndex`). Inter (UI) + JetBrains Mono (data) are now vendored
offline as woff2 under `src/renderer/assets/fonts/` and wired via
`@font-face` - no CDN. The rail's theme button is now a sliding sun/moon
pill (Lucide icons); the pager, columns button, table-collapse button, zoom
cluster, and every modal/panel close X are now inline Lucide SVG on a shared
`.icon-btn` style, replacing the old plain-glyph buttons. A new portable
project bundle (`.aresproj.json`, `src/shared/project-file.ts`) lets Save
project (Export menu) write the run's tags/dismissed/rule-overrides plus an
opaque layout blob, and Open project (Open menu) re-ingest the referenced run
(with a relocate prompt if the file moved) and re-apply the bundle via the
run's sidecar. A `dirty` flag + a new Quit rail item + a window-close
interception (`win.on('close', ...)`) now show a Save / Don't Save / Cancel
prompt when there are unsaved tag/rule/dismissal changes. Also fixed the
long-standing giant grey arrowhead on dimmed graph edges (see the FIXED entry
below). Full detail in `DOCUMENTATION.md`'s "UI/UX round 2" section.

### Screenshot-harness hygiene nuisance
- **The shots harness's Add-Tag step writes into the tracked fixture sidecar.**
  `npm run shots` drives an Add-Tag interaction against
  `tests/fixtures/detector_snap.jsonl.ares-desktop.json` (the tracked example
  sidecar), so each harness run mutates a tracked file and shows up as a
  working-tree diff. Pre-existing, not introduced this session; address by
  running the harness against a temp copy of the fixture (or a temp
  `userData` dir) instead of the tracked one.

### Deferred by design
- **Project-bundle auto-save.** Save project is manual-only (Export menu or
  the save-on-close prompt); there is no periodic or on-change auto-save of
  the bundle.
- **Multi-run bundles.** `ProjectBundle.run` is a single run reference; a
  bundle spanning a diff-mode pair (run A + run B) is not supported.
- **Bundle `layout` is round-tripped but not applied on open.** `project:open`
  returns `{ summary, layout }` and the bundle carries whatever `layout` blob
  was passed to `project:save`, but nothing on the open path re-applies it to
  the renderer's panel/column layout state - it is currently write-only.
- **`enabledOverrides` is not carried in the bundle.** `ProjectBundle` has
  `ruleOverrides: Rule[]` but no field for the per-rule
  `enabledOverrides` map (`RuleScope.enabledOverrides` in
  `rasp-heuristics.ts`), so a rule that's been enabled/disabled without being
  forked into a project-scope override does not round-trip through
  Save/Open project.

## Shipped (2026-07-13) - UI/UX redesign: rail shell, stacked call-site table, graph empty-state

Replaced the chrome-bar/File-dropdown/segmented-switch/filter-bar shell with a
left icon rail (`#rail`, collapsed 46px, hover-expands to ~172px; inline SVG
icons, no emoji) grouped into view (Graph/Flame) / tools (Suggestions, Rules,
Diff, Capture) / file (Open, Export, Log) zones plus a bottom theme toggle, and
a single command bar (`#cmdbar`: omni filter + syscall/library/tid/has-java_stack
+ Apply). Export and Diff now open as modals from the rail. The Quit menu item
was dropped from the UI (window close / Ctrl+Q still quit). The master table
gained a stacked call-site cell (java-over-native or function-over-caller, `↳`
/ `◂ from` prefixes, uniform 40px rows, leaf `title` tooltips), tag chips, a
funcs duration bar with red-hottest highlighting and red negative retval, a
stacked/split column-picker toggle with an SVG-locked id column, and
per-column drag-resize (double-click grip auto-fits; widths persist per engine
under `ares.columns.<engine>` alongside the column set + mode). The graph pane
gained a "Pick a row to trace its call chain" empty-state prompt, kind-glyph
node label prefixes (`◆`/`●`/`■`), and demoted the truncation banner to a
gated top-right chip shown only after a selection (fixes the old load-time
overlap with the empty-state). Full detail in `DOCUMENTATION.md`'s "UI shell",
"Master table columns", and "Graph empty-state and node labels" sections.

### Deferred by design
- **Compact single-line table density toggle** - the redesign settled on the
  taller 40px stacked-cell row as the default; a compact mode that drops back
  to one text line per row (trading the stacked call-site/duration-bar detail
  for row density) was considered and deferred, not forgotten.
- **Drag-to-reorder columns** - column width is drag-resizable and the
  stacked/split call-site mode is toggleable, but column *order* is fixed by
  `ALL_COLUMNS`/`engineColumnKeys`; reordering by drag was out of scope this
  pass.
- **Graph left-to-right layout mode** - the focused subgraph's ELK layout
  still flows top-down only (java → native → syscall reads downward); a
  left-to-right orientation option was considered for wide/shallow chains but
  deferred.

### Cleanup debt
- **Legacy column exports are now dead code.** `columnsForEngine`,
  `serializeColumns`, `parseColumns`, `DEFAULT_COLUMNS`, and `ENGINE_KEYS` in
  `src/renderer/columns.ts` predate the `ColumnLayout`/`parseLayout`/
  `serializeLayout` model this redesign introduced; `main.ts` no longer calls
  any of them (it reads/writes `ColumnLayout` end to end), but they're still
  exported and still covered by `tests/columns.test.ts`. Remove both the
  exports and their tests in a follow-up cleanup pass.

### Pre-existing bug - FIXED 2026-07-14 (UI/UX round 2)
- **Dimmed off-path graph edges render oversized grey arrowheads.** Visible in
  the `04-filtered` / `08-collapsed` screenshots: a long dimmed (out-of-path)
  edge's arrowhead renders disproportionately large relative to its stroke
  width. Two fixes landed: (1) edge width is now clamped via `mapCount`
  (`src/renderer/graph-view.ts`) because cytoscape's `mapData` style function
  extrapolates past its declared domain for counts outside `1..50`, producing
  an unbounded width on very hot edges. (2) **the real cause** turned out to
  be that a triangle arrowhead scales with both edge width *and* the current
  zoom level, and a small, heavily-zoomed-in focused subgraph magnifies that
  scaling - the width clamp alone didn't kill the blob. The actual fix is
  `edge.dimmed { target-arrow-shape: none; width: 1 }`: an off-path edge now
  drops its arrowhead entirely and goes hair-thin instead of trying to tune
  arrow-scale/width numbers down. See `DOCUMENTATION.md`'s "Graph edge
  rendering fix" section.

## Shipped (2026-07-13) - java_stack graph fidelity Phase 2 (JNI interleaving)

The desktop now ingests the `<run>.jsonl.stacks` sidecar (`cfi_stack` records -
the full ordered CFI walk per `stack_id`, each frame `kind`-tagged) and builds an
event's call-graph chain from it when present, recovering the true
managed↔native interleaving and the outer-native caller that the frame-pointer
backtrace drops (it stops at the first JNI trampoline). `chainOfCfi` oracle +
`CFI_CHAIN_SQL` / `CFI_FUNCS_CHAIN_SQL`, per-row `LEFT JOIN` on a `stack_id`-deduped
cfi CTE, `CASE`-selected against the Phase-1 fallback. Wired through every
chain-building query (graph, flame, node inspector, diff, orphan-check) so all
views agree; cfi- and fallback-derived nodes coalesce on the shared id grammar.

### Known drawbacks / follow-ups
- **Diff and orphan-check remain syscall-only.** `nodeCounts` (behind `diffTable`
  and `orphanTargets`) scopes to `type = 'syscall'`; a funcs-only run's diff/orphan
  views are empty. Pre-existing before Phase 2 (the cfi wiring just followed the
  existing syscall scope); widen to funcs when funcs diff is needed.
- **cfi drift guard is presence-only.** `cfiEmittedKeys()` scans all of
  `symbolize.c` with an unscoped key regex (same pattern as the funcs drift test):
  it catches a removed/renamed key but not a second JSON emitter added to that file.
  Safe today (one emitter); tighten to a function-bounded scan if that changes.

## Shipped (2026-07-13) - activity log + status-pill removal

Replaced the always-visible bottom-left status pill with an in-memory **activity
log**: File ▾ Log opens a live, color-coded terminal modal recording every user
action (load / export / capture + tracer output / rule updates / tag edits /
preflight) by level; Save writes `ares_<date>_<time>.log`; Clear empties it.
Load progress moved to a thin bar on the empty-state. `log-store` (pure ring
buffer), `run-logged` (action wrapper), `log-view` (modal).

### Known drawbacks / follow-ups
- **Failed rule saves are not logged.** Rule logging hangs off `renderRules`'
  `onChange` (fires only after a successful save), and `rules-view.ts` was left
  untouched, so a *failed* rule save produces no `error` entry. Instrument the
  `rulesSave` call sites directly when rule-save failures need surfacing.
- **Ingest progress bar can stick on a failed first load.** `onProgress` shows
  the bar and only `onLoaded` hides it; if a first ingest errors before it
  completes, the bar stays. Pre-existing behavior inherited from the old status
  pill; hide the bar on an ingest-error path.
- **Clear-sentinel value overload.** `logClear` notifies subscribers with a
  `LogEntry` whose label and message are both empty, and the modal treats that as
  a redraw signal; a future `logAppend('', '')` would be silently swallowed. No
  call site does this today (all labels are non-empty). Harden with a distinct
  clear signal (e.g. a `kind` field or a symbol) if real call sites risk it.
- **GUI smoke pending.** The log modal, Save dialog, and empty-state progress bar
  need an interactive Electron pass; the store/wrapper/save-IPC seams are unit +
  build covered.
- **No persisted-across-restart log** - in-memory only; Save is on-demand.

## Shipped (2026-07-13) - funcs inspector + engine-aware column picker

The column picker now shows only the active engine's columns and persists toggles
per engine (`ares.columns.<engine>`, legacy `ares.columns` = syscall fallback).
Clicking a funcs graph node or table row renders the funcs records in the detail
panel: a records-behind-node list (id / caller / retval / elapsed / args) with
click-for-detail (args / string_args / fd_args / sock_args / out_args / backtrace),
fed by engine-routed `eventById`/`nodeEvents` that merge a `call` with its
shared-`id` `return`. `COLS` + `FuncEvent` widened for the detail fields
(`caller_addr` intentionally omitted - funcs_emit.c never serializes it).

### Known drawbacks / follow-ups
- **Funcs offset popup not wired.** A funcs native node has no ghidra
  image-base offset popup (`nodeOffsets` stays syscall-only); node-tap skips it on
  funcs runs. Wire it when funcs offset mapping is needed.
- **No aggregate/summary node header.** The funcs node panel is a raw record
  list; a hot node (thousands of calls) gets no call-count / elapsed p50-max / top
  callers summary. Add an aggregate header later.
- **`nodeEvents` funcs capped at `limit`** (default 500) like the syscall path; a
  very hot node under-lists past the cap.
- **Inspector renderer duplication.** `renderFuncDetail`/`showFuncsNodeInspector`
  near-duplicate the syscall `renderEventDetail`/`showNodeInspector`; both consume
  the shared `DetailSection` union, so a single `renderDetailSections` + shared
  node-table builder could collapse them. Refactor candidate, not urgent.
- **`retval_str` unused.** ARES emits a decoded `retval_str` for funcs; the
  inspector shows only the numeric `retval`. Consider surfacing it for
  pointer/handle-returning funcs.

## Shipped (2026-07-13) - funcs engine support, Phase 1

Loads `ares funcs` runs: engine detection at ingest (`RunInfo.kinds`), a funcs
master-table list (function / caller / retval / elapsed / args) with retval/elapsed
folded from the matching `return` by shared `id`, and a deep unified
function-to-function call graph built in SQL (`FUNCS_CHAIN_SQL`, replaces the old
JS `funcsAdapter`) verified against the `foldFuncEvents` oracle. Off-heap and
`span IS NULL`-guarded throughout.

### Known drawbacks / deferrals from funcs Phase 1 (to resolve later)
- **GUI smoke test pending on a fresh capture.** Core logic is covered by unit +
  integration + lockstep tests, but the interactive Electron smoke (funcs columns
  render, row-click draws the gold `fn:` graph) was not run: the committed
  `../ares-detector-funcs-sample.jsonl` predates the tracer's `id` field, so it
  lists calls with null ids and no folded retval/elapsed. Recapture a funcs run
  (with `id`) and run the smoke before calling the feature user-ready.
- **Funcs `stack_id` dropped.** funcs emits `stack_id` as a large raw number;
  it is unused (no stack sidecar in funcs output) and left unmapped. Revisit if a
  stack sidecar lands.
- **funcs-vs-syscall run diff is not meaningful** (node-id namespaces differ);
  diffing two funcs runs is the intended use.
- **Deferred to Phase 2/3:** module/symbol filter-control UI, flame view for
  funcs, run diff + RASP heuristics for funcs. (Engine-aware column picker and the
  funcs record inspector shipped - see the section above.)

## Known drawbacks from body-panel & master-table redesign
- **Tags column keys on innermost native frame only** - the tag lookup on a
  syscall row resolves only the row's `topNative` (innermost native frame in the
  backtrace). A tag on a non-innermost native frame in that same row will not
  badge that row, even if the frame is part of the chain. Revisit when a use case
  needs tagging at arbitrary depths or you want to highlight any tagged frame in
  a call chain, not just the innermost.
- **Paging is offset-based, no jump-to-page** - the table pager steps prev/next
  in fixed 500-row windows over the sorted result. There is no "jump to page"
  input or bookmarking by event id; to reach a target deep in a large result,
  narrow the filter first. Consider adding a page-jump input if analysts
  regularly need to navigate large filtered sets.
- **Rapid row-click race on eventById fetches - RESOLVED 2026-07-11** - `selectRow`
  now captures a monotonic selection epoch (`src/renderer/selection-epoch.ts`) and
  bails both the `eventById` detail paint and the `slice` graph paint when a newer
  row selection has superseded it, so the last-to-resolve fetch can no longer paint
  a stale record/graph under the current highlight. The same epoch also guards the
  diff-mode row's merged-subgraph paint (`diffSlice`), so switching diff rows mid
  fetch can't repaint a superseded graph either.
- **Column truncation at default table width** - at the default ~420px table
  width, text-heavy columns (`top native`, `args`) truncate. Mitigated by: (a)
  resizing the table panel wider (persistent in `localStorage`), (b) `title`
  tooltip on hover, (c) full detail in the right-panel single-record view. This
  is the intended trade-off; revisit only if the truncation becomes frustrating
  in daily use.

## Known drawbacks from node-interaction rework (offset/tag popup placement)
- **Offset popup size estimates** - `placePopup` uses a fixed 400×300 estimate to
  compute right/left anchor placement; if the actual rendered popup size drifts
  (e.g. from label wrapping or content changes), revisit the estimate constants
  to keep the popup positioned correctly relative to the node.
- **Offset popup-inspector overlap (cosmetic)** - when a node is centered in the
  viewport, the offset popup can overlap the right inspector panel transiently;
  z-order keeps the popup readable. Revisit if the overlap becomes distracting
  in daily use.
- **Stale async re-open of the offset popup - RESOLVED 2026-07-11** - the native
  node-tap handler captures the selection epoch and guards inside its `.then`
  before filling the inspector / opening the popup; the empty-canvas tap and any
  other node selection bump the epoch, so dismissing or switching during a slow
  IPC round-trip discards the resolved continuation instead of re-opening the
  popup at the old node.
- **Harness coverage niceties** - the shots harness does not yet assert that a
  syscall/java tap leaves no inline tag editor, nor that the tag popup's computed
  background is themed (both are visually covered by the captures); add explicit
  assertions if the DOM regresses.

## Known drawbacks from Phase 1a (native offset popup - `GraphStore.nodeOffsets`)
- **`unlib`/library reload not handled** - the module map takes the global
  lowest `start` per (pid, basename), so offsets are wrong for events on the
  far side of an unload+reload at a different base (spec §14 Phase 2).
- **`nodeOffsets` 5000-event aggregation cap can silently under-count**
  `count`/`reaches` for a very hot node; consider surfacing a `truncated` flag.
- **APK-embedded modules** - a frame module `base.apk -> libinner.so` won't
  match the map's basename key, so those frames get no offset.
- **`moduleRelative` returns a malformed `"0x-.."` string if `addr < base`**
  (unreachable today; add a defensive guard when the Phase-1b popup consumes
  real addresses).
- **`[unmapped]` offsets in snapshot captures** - offsets resolve only when the
  run carries `lib` records, which the ARES tracer emits on `mmap` during the
  trace. A snapshot or post-load capture has no `lib` records (modules already
  loaded at attach time), so all offsets show `[unmapped]`. The durable fix is
  ARES-side: prime the module map from `/proc/<pid>/maps` at attach time so
  snapshot captures can resolve offsets. Until then, capture from process start
  for offset resolution.

## Known drawbacks and deferrals from UI/interaction refinement (this session)
- **Click-to-expand native-node drill-down was deferred** - a Phase-2 feature to
  load a native node's full cross-run neighbourhood on demand was deprioritized
  in favor of the brighter-edge highlight (single click now clearly illuminates
  the whole call chain). Still a valid Phase-2 candidate (spec §5.3).
- **Highlighted-edge emphasis** - the selected path's edges were strengthened
  (`width` 3.5, full-strength color, `arrow-scale` 1.3) so a single click clearly
  lights the chain on dark backgrounds; base (unselected) edges are unchanged
  (`arrow-scale` 1.2). Revisit the emphasis if it reads too heavy on light theme.

## Shipped (2026-07-07) - extensible RASP heuristics engine; UI/UX overhaul partially shipped
Design reference: overall spec §13.

- **Extensible heuristics engine - SHIPPED.** Feature 5 evolves from hardcoded
  rules to a declarative, user-authorable rule schema (fixed op vocabulary
  `path_matches`/`equals`/`arg_hex_eq`; no user SQL or code). Two compilers
  (`compileWhere` -> bounded SQL pre-filter, `scoreWith` -> per-event JS scoring
  authority) kept in lockstep by a real-DuckDB integration test. Built-ins
  corrected/extended, validated against the real 245,760-event ARES-Detector
  capture: fixed debugger under-firing (`PTRACE_ATTACH` + `openat
  /proc/self/status` - the previous TRACEME/read-only rules under-fired on the
  real RASP), added `hook` (`/proc/self/maps` + frida `sock_addr`), expanded
  `root` (selinux, `/data/adb`, busybox, KernelSU `prctl 0xDEADBEEF`). Rules
  merge across three scopes - `BUILTIN_RULES` + global library
  (`<userData>/rasp-rules.json`) + per-project override (run sidecar) - via
  `resolveRules` (later scope wins on id collision) and `enabledOverrides`
  (same precedence, per-rule enable/disable). Persistence + tests done this
  session.
- **emulator / integrity - documented not-syscall-detectable** (replaces the old
  "stubs" item below): property reads aren't syscalls; own-`base.apk` reads are
  indistinguishable from normal loading. Categories stay for manual tagging; no
  auto-rule.
- **Rule-authoring UI - SHIPPED.** A `#rules` floating panel (predicate-builder
  editor: id/category/confidence/rationale/syscalls/field/op/argIndex/value)
  covers add/edit/delete/enable-disable for global and project rules, a
  global/project scope picker on the editor, a live debounced "N matches → M
  targets" preview against the current run (`GraphStore.previewRule`), and
  builtin fork + reset (editing a builtin forks a same-id override into the
  chosen scope; Reset drops that override from both scopes to restore the
  plain builtin).
- **UI/UX production overhaul, first slice - SHIPPED.** Graph zoom
  (in/out/fit over `cy.zoom`/`cy.fit`) and the coherent layout + visual pass
  (drag-resizable, collapsible, `localStorage`-persisted panels in
  `src/renderer/panels.ts`/`wirePanels`; a token dark/light theme in
  `src/renderer/theme.ts` that is now the single source of the java/native/
  syscall colors for cytoscape, `#legend`, and the flame view; the chrome-bar
  / filter-bar split; empty/loading/error states) are done. See
  `DOCUMENTATION.md`'s "UI shell" section.
- **Still deferred: UI/UX production overhaul (conference-presentable bar).**
  - **Confirm-to-tag produces no visible output - RESOLVED** - the Suggestions
    `onConfirm` handler (`src/renderer/main.ts`) now upserts the tag, persists the
    sidecar, then repaints all three surfaces the tag can appear on: `refreshTable`
    (master-table tag column), `redrawBadges` (graph node badge), and `recolorRasp`
    (native-node RASP category border). Confirm is observable on every view.
  - **Filter into a popover/panel** - move off the non-scalable top toolbar.
- **Final-review residual minors (not urgent, tracked for follow-up):**
  - Dedup: `CATEGORIES` array duplicated in `rasp-heuristics.ts` +
    `project-store.ts`; `coerceOverrides` helper duplicated in
    `rasp-rules-store.ts` + `project-store.ts` - fold into the shared module.
    (The separate java/native/syscall **color** triplication across
    cytoscape/`#legend`/flame is now **resolved** - single-sourced via
    `themeColors` in `src/renderer/theme.ts`, which also owns `labelBacking`
    and `labelText`. Intentionally left theme-fixed, not missed conversions:
    the `node[badge]` purple border, flame `root` grey, and the capture
    console colors - they read acceptably on both canvases.)
  - `aggregate()` collapses multiple same-target categories to the
    highest-confidence one (both rationales are concatenated, but the
    lower-confidence `category` is overwritten) - revisit when a native frame
    is legitimately both root and hook.
  - `rules-view.ts`'s `rulesPreview().then` has no `.catch` - a rejected
    preview call (e.g. IPC error) leaves the preview text stuck on its last
    value with no error shown.
  - `setEnabled` shallow-copies every rule in the scope (`rules.map(r => ({
    ...r }))`) just to add one `enabledOverrides` entry - unnecessary; only
    `enabledOverrides` needs a new object.
  - **CLOSED:** `npm run shots` had no Rules-panel step; a Rules-panel open/
    close step is now present in `scripts/screenshot.mjs`, so panel/editor
    regressions are caught by the visual snapshot pass.

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
- **emulator / integrity / hook heuristic rules were stubs - RESOLVED
  2026-07-07** (see the "Shipped" entry at top): `hook` shipped
  (`/proc/self/maps` + frida `sock_addr`); debugger under-firing fixed
  (`PTRACE_ATTACH` + `openat /proc/self/status`); `root` expanded (selinux,
  `/data/adb`, busybox, KernelSU `prctl`). `emulator`/`integrity` are
  documented not-syscall-detectable and remain manual-tag-only categories.
- **Rule-engine SQL/JS lockstep** (mental note for the next ARES-version bump) -
  `compileWhere`/`scoreWith` must stay in agreement on every rule's semantics
  (in particular hex-arg formatting, e.g. ARES's `jb_hex` always emitting
  `"0x0"` for a zero request); this is covered by a real-DuckDB lockstep test,
  not by `tests/schema-drift.test.ts` (which only checks field names). Re-run
  the lockstep test whenever the vendored ARES schema version is bumped.
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

**Shipped: capture-form redesign + push guard** - the Capture modal is now a
sectioned form (host setup / engine & arguments / run), host binary and specs
dir fields get live validity dots (`tracer:checkPaths` → `path-check.ts`'s
`isElf` + `hasSpecFile`) and native Browse pickers (`tracer:pickBinary`,
`tracer:pickSpecsDir`), preflight checks stream in one at a time
(`tracer:preflight-check`) instead of arriving as one batch, and the
renderer's preflight handler no longer gets stuck on "running preflight..."
on an IPC rejection. `preflight()` also guards the push branch: an
unreadable/empty host binary or an empty `specsDir` now fails a `binary`
check up front instead of running `adb push` - closing the previous
`adb push /.` (whole host filesystem) hazard from an unconfigured host.

**Shipped: optional specs dir + probe-spec discovery** - the host specs dir
moved out of host setup into the engine section, shown only for spec engines
(`funcs`/`correlate`/`trace`, gated by `capNeedsSpec`); an empty specs dir is
now *skipped* by preflight rather than failing it, and the specs push runs
only when the dir is set (the binary is always pushed when stale, regardless).
The probe-spec field is now a dropdown populated from `tracer:listSpecs` →
`path-check.ts`'s `specNames` (the `.spec` basenames in the configured dir),
repopulated in place via `applySpecChoices` on every specs-dir edit.

### Known drawbacks / follow-ups from feature 9
- **`correlate` capture renders no graph.** The correlate graph adapter was
  removed (its cross-engine edge coloring had unclear goals). The `correlate`
  capture capability is still selectable, so a correlate run captures a JSONL
  that the desktop ingests but does not render as a graph. Either hide the
  `correlate` capability or restore a dedicated correlate visualization later.
- **`--snapshot` native `.stacks` sidecar is not pulled or consumed.** Enabling
  the capture form's stack-snapshot toggle makes ARES write a native
  `<out>.jsonl.stacks` sidecar (raw CFI stack snapshots for off-device DWARF
  unwinding) next to the pulled `.jsonl`. The desktop pulls only the `.jsonl`
  and has no in-app CFI/DWARF unwinder, so the sidecar is left on device. The
  Java-frame payoff still lands inline in the `.jsonl` (that path does not need
  the sidecar); native off-device unwinding would need a separate unwinder.
- **`trace` capability argv is rejected by ares.** The `trace` cap builds
  `trace -P <pkg> -F <spec>`, but the real `trace` engine
  (`../ARES/src/trace/trace_args.c`) accepts only `-P/-p/-A/-o` plus section
  delimiters (`--syscalls`, `--funcs`, `--lib`, `--dump`, `--correlate`) at top
  level; a top-level `-F` is an unknown-arg parse error. Rebuild the `trace` cap
  as a section-based builder (e.g. `--funcs -F <spec>`). Until then `trace` runs
  fail on device. The `-b/-Q/-v` tuning flags were intentionally not wired to
  `trace` because its top level does not accept them either.
- **Rules editor is a single-stacked form** - the predicate-builder form
  (`id`, `category`, `confidence`, `rationale`, `syscalls`, `field`, `op`,
  `argIndex`, `value`) renders as a vertical column without per-field inline
  validation indicators; consider field-level error UI if validation feedback
  becomes important beyond the current pre-dispatch `draftFromForm`/`validateRule`
  checks. **Partially addressed** - the Capture form now renders per-field
  inline errors (`.cap-input-err` spans populated from `fieldErrors`); the
  Rules editor itself is untouched and still lacks this.
- **`dump` dumps on app *exit* by default** (post-decryption) - the capability
  does not expose `--on-map` (dump-the-instant-a-lib-maps) or `-p <pid>`
  (attach to a running process). For a short UI window the on-exit default
  relies on the app exiting or the timeout firing. Add `--on-map` / attach-pid
  as dump options if a real use needs a mid-run dump.
- **`mod` analyzer is a free-text field** - the analyzer name is typed by the
  user, not discovered from `ares mod --help`. Parse the analyzer list at
  runtime when this is exercised on device (spec §9 open item).
- **`funcs`/`correlate`/`trace` spec is a free-text filename** - **RESOLVED
  (2026-07-12)**: the probe-spec input now renders as a dropdown
  (`tracer:listSpecs` → `path-check.ts`'s `specNames` lists the `.spec`
  basenames from the configured host specs dir), not free text. These JSONL
  engines were not exercised on-device this session (only `syscalls`, `lib`,
  `dump` were); smoke them when a spec-driven run is needed.
- **stdout/artifact runs never send a UI "run loaded" signal** - only `jsonl`
  runs auto-switch to the table; `lib`/`dump` leave the result in the console /
  `userData/runs/` with no in-app artifact browser yet.
- **Cross-modal streamed-row leak on `onPreflightCheck`** - the top-level
  subscription appends each streamed check to whatever `cap-preflight-status`
  element currently exists in the DOM. If a preflight is still streaming when
  the user closes and reopens the Capture modal, late rows from the old run
  can land in the new modal instance's status host. Fix approach: tag each
  streamed check with a per-run token from the main process (or gate the
  subscription on the active preflight epoch) and drop stale ones before
  appending.
- **Preflight only refreshes the on-device specs on a binary push** - the
  specs push (`mkdir -p` + `push .../.`) lives inside the same branch as the
  stale-binary push in `preflight()`. If the on-device binary is already
  current, a spec-engine run is not guaranteed a fresh specs push even if the
  host specs dir changed since the last run. Follow-up: give the specs push
  its own freshness check instead of piggybacking on the binary's.
- **Specs-dir field can go stale if the analyst switches to a spec engine
  before `getTracerConfig()` resolves** - `wireCapture()` draws the initial
  form synchronously and only later awaits `getTracerConfig()`. If the
  analyst switches the engine dropdown to a spec engine in that window,
  `drawForm()` renders the specs-dir input from whatever `specsDir` currently
  holds - `''` if config hasn't resolved yet. When the config promise later
  resolves, `refreshSpecList` repopulates the spec dropdown, but nothing
  pushes the resolved `specsDir` value into the rendered `<input>`, so the
  field stays blank even though the closure variable now holds the real path.
  Fix approach: on config-load, if `capNeedsSpec(capById(sel.value))`, also
  set the rendered `[data-config="specsDir"]` input's value from the resolved
  config (and re-run `refreshSpecsDot`).

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

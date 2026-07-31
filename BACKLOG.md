# Anubee-Desktop - backlog / next-session guide

Log here: features shipped with a known drawback to resolve later, deferred work,
and open verification items. Newest concerns first.

## Shipped (2026-07-31) - accurate rule library, new primitives, real attribution

The heuristic engine gained five rule primitives - `decoded_args` as a match
field, an `arg_hex_in` operator, an `op: 'any'` syscall-only step, a `retval`
step modifier, and a rule-level `minOccurrences` noise floor - plus an
`unordered` co-occurrence matching mode beside the existing ordered sequences.
Attribution now classifies a native module from its real load path (from the
tracer's `lib` records) instead of a basename denylist, falls back to a
platform-filtered java frame, and mints a synthetic `rasp:unattributed:<category>`
target when nothing app-owned survives. The built-in library went from 10 rules
to 30, with `emulator` and `integrity` covered for the first time. The rule
editor exposes all of it. See `DOCUMENTATION.md`'s "Heuristic pre-tagging" and
"RASP rule-authoring UI".

Two measured results worth keeping: on the reference detector fixture the
TracerPid rule now catches **106 of 106** `/proc/<pid>/status` probes where its
predecessor caught **1** (it anchored on `/proc/self/` while real code uses
`getpid()`), and the 17 root-path probes that previously collapsed onto the
meaningless `nat:base.vdex` now name the app's own Kotlin check.

### Known drawbacks / follow-ups
- **Unattributable multi-step sequences still match nothing.** A one-step rule
  needs no correlation key and can reach the synthetic target; a multi-step rule
  still requires one, so an unattributable sequence stays invisible. Accepted:
  the alternative, a thread-keyed placeholder correlation base, would group
  unrelated java checks running on one thread into a single stream and create a
  false-positive class that does not exist today.
- **Attribution quality depends on the capture carrying `lib` records.** Without
  them the path classifier is inert and the basename fallback does all the work,
  so a platform library absent from that list can be named as the app's own.
  Observed on the reference detector fixture, which carries zero `lib` records.
  The deliberate bias is to prefer `app-native` when a module is unknown, because
  a wrong `platform` silently drops a real finding whereas a wrong `app-native`
  merely names an odd node the analyst can reject.
- **Roughly 72% of hits on Java-implemented checks cannot name the app's own
  caller.** Anubee byte-caps `java_stack` innermost-first, so a deep
  Kotlin/Compose stack keeps the framework frame and drops the app's class. The
  synthetic target is the local mitigation; **the real fix is raising that cap in
  the tracer**, which would convert most of that share into real attribution.
- **`chainOf` is built twice** for any event with no app-native frame (once in
  `attributionOf`, once in the java-id helper). Correct but wasteful, and that is
  the dominant path for exactly the events the attribution work targets.
- **An unordered rule opens a partial on any matching step**, so a key that
  repeatedly emits one step's shape burns matcher cap where the ordered form
  opened nothing. Bounded by evict-oldest and counted in `dropped`, so the
  matcher cannot go blind.
- **An unordered rule's steps must be mutually exclusive.** Step assignment is
  greedy by ascending index with no backtracking, so if two steps can match the
  same event the rule can under-report. The three shipped unordered rules are
  exclusive; a rule author gets no warning.
- **`op: 'any'` widens the DuckDB prefilter** to a bare `syscall IN (...)`. It is
  denylisted on eighteen high-frequency syscalls and `suggest` warns past a
  candidate-row budget, but a rule over a moderately busy syscall still costs a
  full scan of that syscall's rows.
- **A `retval` condition silently skips enter-only records.** Roughly 29% of
  events in the reference production capture carry `retval: null`, so
  `root-found` and `hook-frida-port-taken` under-report on snapshot-mode
  captures. Neither is the sole rule for its behaviour.
- **Six built-in rules are authored, not measured.** `root-found`,
  `root-ksu-prctl`, `dbg-ptrace-traceme`, `hook-frida-artefact`,
  `hook-frida-port-taken` and `hook-frida-scan` score zero on every available
  capture because the capture device is clean and unrooted. Re-measure against a
  rooted or emulator-hosted capture when one exists.
- **`root-kernel-files` is `/proc/self`-only for `mountinfo`** while every
  sibling rule accepts `/proc/<pid>/`. That is the exact recall bug this work
  exists to fix, still present in one pattern.
- **`hook-xposed`'s tokens are unanchored** (`xposed|riru|zygisk|substrate`),
  the same shape as the `gadget` token that scored 86 false positives before it
  was anchored. Far more distinctive, so the risk is low, but unmeasured.
- **`funcs`-engine records are still invisible to rules.** `suggest` is scoped to
  `type = 'syscall'`. Matching `call` / `return` records would expose
  `__system_property_get("ro.kernel.qemu")`, `dlopen` of a hook library, and the
  native-API surface that never reaches a syscall with a matchable argument.
  Deferred because no available capture contains `funcs` records, so no such rule
  could be validated.
- **The rule-form modal scrolls horizontally by a few pixels**, from `.rf-step`'s
  negative-margin full-bleed trick. Pre-existing and unchanged by this work.
- **A `minOccurrences` floor on the synthetic unattributed target counts
  run-wide, not per call site.** Every unattributed hit on a rule shares one
  target for the whole run, so the floor there answers "did the run contain N
  in total" instead of "did this call site do it repeatedly". Confirmed on a
  real capture: `env-prop-sweep` (floor 100) clears it with 780 unattributed
  hits alone, and five other rules clear their floors the same way.

## Shipped (2026-07-23) - RASP sequence rules + call-site attribution

The RASP heuristic engine (`src/shared/rasp-heuristics.ts`) moved from a
stateless single-event predicate per rule to an ordered `steps` sequence
matched by a stateful `SequenceMatcher`, correlated by `symbol` / `symbol+tid`
/ `module` / `module+tid` / `java` and bounded by a `maxGap` event window.
`compileWhere` widened to a per-step SQL prefilter (still the sole thing that
reaches DuckDB); the matcher remains the scoring authority. Hits resolve to a
module-relative call-site offset (`src/shared/origins.ts`) and aggregate to
`(target, category)` suggestion rows with per-offset children, so a rejection
or confirmation can act at either the row or the individual call-site level.
The rule-authoring UI (`src/renderer/rules-view.ts`) gained a repeating step
block (Add step / Remove step) plus `correlate`/`maxGap` controls, and a new
built-in, `hook-frida-scan`, ships as the first two-step sequence rule (a maps
walk followed by a frida-artefact probe). See `DOCUMENTATION.md`'s "Heuristic
pre-tagging" and "RASP rule-authoring UI" sections.

### Known drawbacks / follow-ups
- **`suggest`'s candidate scan is paged, and a wide rule library widens it.**
  `GraphStore.suggest` reads its DuckDB candidate set in pages (default 20000
  rows, injectable per store instance via the constructor's `suggestPage`
  option), and the `compileWhere` prefilter is an OR across every rule's every
  step - so a larger built-in or user rule library admits more rows per page
  and does more DuckDB work per page fetched. Re-measure the page size if the
  built-in rule set grows substantially.
- **`maxGap` counts rule-relevant events, not elapsed time**, because Anubee
  syscall records carry no timestamp for the matcher to measure against - a
  time-based window is not something the tracer's output can support. A rule
  tuned to fire reliably on one workload's event rate may need its `maxGap`
  retuned for a workload where the same real-world gap spans a different
  number of rule-relevant events.
- **Cross-step value binding (a step referencing a value an earlier step
  captured) is not implemented.** Adding it would defeat the SQL prefilter:
  matching "the same value across two steps" cannot be expressed as a bounded
  per-row `WHERE` clause, so it would force the whole run's event set onto the
  JS heap to check in JS instead - exactly what `compileWhere` exists to avoid.
  The concrete residual gap this leaves: an `fd_args` value whose `readlink`
  failed carries no path at all (`fd=<n>` with nothing to unwrap) and so
  cannot be linked back to the `openat` that produced that fd - 168 of 4367
  fd-referencing events (3.8%) in `tests/fixtures/detector_snap.jsonl`.
- **A rule step matches exactly one `field`.** "This path was either opened or
  read" needs two rules, or two steps in one rule (one per field) - a step
  cannot itself say "match in `string_args` OR `fd_args`". Widening `field` to
  accept a list was considered and rejected: it would multiply the number of
  clauses `compileWhere` emits per step (one per field in the list), for a
  case union types can already express with an extra step or rule.
- **`SequenceMatcher` reports at most one occurrence per event per rule per
  correlation key.** It advances only the oldest in-flight partial on a match
  and consumes (retires) a partial the instant its last step completes, so two
  independently-interleaved sequences sharing one correlation key (e.g. the
  same thread running the same check twice, back to back, before either
  finishes) report as one occurrence, not two. Accepted: the alternative -
  advancing every eligible partial per event - multiplies matcher work by the
  number of live partials per key per event, for a case (self-interleaved
  identical sequences on one thread) that is rare in practice.
- **`SequenceMatcher.counts` is never pruned.** Unlike `partials` (bounded by
  `cap` plus a periodic sweep) and `ages` (periodically compacted), `counts`
  keeps one entry per distinct correlation-key stream ever seen, for the life
  of a `suggest()` run, and is never trimmed. This is bounded per-key metadata
  (a single number) over an already-DuckDB-prefiltered candidate set, judged
  an acceptable cost - but it is the only structure in the class with no cap
  and no reclaim path. Revisit if a run with an extreme number of distinct
  correlation keys (e.g. `symbol+tid` on a very high-thread-churn capture)
  makes it measurably large.
  Record alongside it that **`SequenceMatcher.hits` is unbounded too**: it grows
  O(matched candidates) for the life of a `suggest()` run, and at peak three
  same-length arrays are live at once (`finish()`'s defensive copy, the
  `ResolvedHit[]` `resolveHits` maps out of it, and `aggregate`'s input). Judged
  acceptable because it is bounded by how much a run *matches*, not by run size -
  a capture with millions of events but few RASP behaviours costs nothing here.
  Revisit together with `counts` if a broad user rule library ever matches a
  large fraction of a big capture; the fix is to aggregate incrementally instead
  of retaining every hit.
- **`SequenceMatcher.sweep`'s keep-predicate runs one stream-event behind the
  advance path's expiry check**, so a partial can linger one event past its
  rule's `maxGap` before the sweep reclaims it. Harmless today: `push` re-checks
  expiry on the advance path before it ever attempts a match, so a lingering
  partial cannot produce a hit it should not have - the lag costs at most one
  extra live slot for one sweep interval. Worth aligning the two predicates if
  the sweep is ever made the sole expiry authority.
- **`dropped` is incremented on the refusal path for a partial that was never
  opened.** `push` bumps it both when eviction frees a slot and when eviction
  reports failure. The second branch is unreachable while `cap > 0`, because
  `evictOldest` always finds a victim once the cap is reached, so the counter is
  accurate in practice - but the two branches mean different things and a
  `cap: 0` matcher would report drops for partials it never held.
- **No test asserts a RESOLVED call-site offset end to end.** The integration
  test asserts `offsets.length > 0`, which also passes when resolution falls back
  to `[unmapped]`, so the byte-identity between a heuristic offset and the node
  inspector's offset popup - the thing tag identity `(target, offset, category)`
  depends on - is unguarded. Closing it needs a `lib`-bearing fixture and an
  assertion that `suggest().offsets[0].offset === nodeOffsets()[0].offset` for
  the same target.
- **`previewRule` is an unpaged full scan of its rule's candidate set, and it
  compiles only that one rule.** Both differ from `suggest`: the scan is
  unbounded in rows (acceptable while a draft rule's prefilter is narrow, not if
  someone previews a rule matching most of a capture), and matching the draft in
  isolation means its counts can disagree with what `suggest` produces once
  other rules are enabled, since a sequence rule's `maxGap` window is consumed
  by any enabled rule's candidates on the same correlation key. See the
  live-preview caveat in `DOCUMENTATION.md`.
- **`.rf-step { margin: 8px -8px }` bleeds its border into the modal gutter.**
  The negative inline margin only looks right because `.modal-body`'s padding is
  wider than it - the rule form is coupled to the one container it is ever
  rendered into. It cannot clip today (the form has no other mount point), but
  the coupling is undocumented and untested; a second host, or a narrower
  `.modal-body` padding, would cut the step border off.
- **The fixture-wide "no platform library target" test's regex covers only five
  of roughly 28 modules in `SYSTEM_NATIVE`,** so it would not catch a suggestion
  attributed to `libbinder.so` or `libnativehelper.so`. Deriving the assertion
  from `SYSTEM_NATIVE` directly (rather than restating a hand-picked subset)
  would be a strictly stronger guard and would not drift when the list grows.
- **`suggest()` runs a full rescan two to three times per user action.** The
  suggestions list and the graph recolour each call it, and every Confirm or
  Reject triggers another round. Pre-existing, but sequence matching made each
  scan materially more expensive (per-event, per-rule partial bookkeeping on top
  of the DuckDB paging), so on a large capture this is seconds of latency per
  click. Fix approach: cache the suggestion set per run and invalidate it on a
  rule or sidecar change, rather than rescanning on every read.
- **The findings export sets a finding's occurrence count to the *target's*
  total event count,** not the count of events the confirmed behaviour actually
  explains. With per-`(target, category)` suggestion rows this is now the normal
  case, not an edge case: confirming root, debugger and hook on one symbol
  exports three lines each claiming the same total. Fix needs the export to
  carry the suggestion's own `occurrences` (or the offset child's) through to
  the `Finding` instead of counting representative events.
- **On a capture with no `lib` records every suggestion's only call-site child
  is `[unmapped]`,** which duplicates its parent row exactly and whose Confirm
  writes a literal `offset: "[unmapped]"` into the sidecar - a tag identity that
  refines nothing but is not equal to the symbol-level one. Consider suppressing
  the children when `[unmapped]` is the only offset, so such a run shows the
  plain row it used to.
- **Pre-existing UI glitch, unrelated to this work but worth recording:** the
  `root-paths` built-in's rule-list meta line (confidence + syscalls, e.g.
  `85% · openat,access,newfstatat,faccessat`) wraps awkwardly onto its own
  line under the id/category chips instead of staying right-aligned on the
  first line, because `.rule-line1 { flex-wrap: wrap }` lets the row's items
  wrap while `.rule-meta { margin-left: auto }` (both `src/renderer/index.html`)
  only pushes the meta span right *within whichever wrapped line it lands on* -
  a long comma-joined syscall list is wide enough to force the wrap. Cosmetic.

## Shipped (2026-07-23) - Capture run-lifecycle fix wave

Pre-merge review of the tracer-control branch found four issues, all fixed:

- **`discardActive` could leak into the next capture.** `activeRun` was
  deliberately widened (previous entry, below) to span the whole pull+ingest
  pipeline, but `tracer:stop`'s guard (`if (!activeRun) return`) still keyed
  off that same flag, so it kept passing during the pull window even though
  there was nothing left to stop. A `Stop & discard` click that landed there
  wrote `discardActive = true` after the only code that read and cleared it
  for that run had already run - the flag then sat there until the *next*
  capture completed, which silently skipped its own pull/ingest. Fixed by
  extracting the run's state (`activeRun`/`activeRunArgv`/`discardActive`)
  into a small phase-aware object (`src/main/run-lifecycle.ts`: `idle` ->
  `device` -> `finishing` -> `idle`) whose `requestStop` only acts in the
  `device` phase and whose `finish()` unconditionally clears everything in
  the IPC handler's `finally`. This also closes the drawback logged below
  ("Stop buttons stay live during the pull/ingest window"): main now
  broadcasts a `tracer:phase` event the moment a run enters `finishing`, and
  the Capture footer swaps to a non-interactive "Pulling & ingesting…" note
  instead of `Stop & discard` / `Stop & open run` - there is no longer a
  Stop that silently does nothing. The lifecycle object is unit-tested
  directly (`tests/run-lifecycle.test.ts`), including the exact
  stop-during-pull-then-next-capture regression; `src/main/index.ts`'s IPC
  handlers otherwise still have no test coverage of their own.
- **The graph-view switch after a capture never actually ran.** A successful
  jsonl capture's own ingest closes the Capture modal (`trace:loaded` /
  `trace:estimate`) before the `tracer:done` broadcast arrives, which tore
  down the module-scope `captureDoneSink` the switch lived inside - so a user
  parked on Flame or Libraries when a capture finished stayed there. Moved
  the `showView('graph')` call out of `captureDoneSink` (which only ever
  finalizes a still-open Capture instance - discard/error/no-runId paths) and
  into the once-registered `onTracerDone` handler in `main.ts`, which runs
  regardless of whether a Capture instance is still open.
- **The flag-drift guard (`tests/anubee-flag-drift.test.ts`) missed the flags
  it most needed to guard.** It derived the desktop's emitted-flag set from
  `buildArgv` alone, missing `commonArgv`'s `-b`/`-Q`/`-v` and the `-o`
  `composeRunArg` appends, and it hardcoded what `COMMON_ARGP_OPTIONS` /
  `TARGET_ARGP_OPTIONS` contain instead of parsing the real
  `../Anubee/src/common/engine_args.h`. Both fixed: `emittedFlags` now goes
  through `composeRunArg`, and the allowed-flag set is parsed from the macro
  source, so an upstream removal from either macro (the `-Q` case tested by
  the mutation drill) fails the guard instead of passing silently.
- **`tracer:start` trusted the renderer's own input validation.** The
  `SAFE_TOKEN` gate (`validateInputs`) only ran in the renderer, and
  `timeoutSecs` was never checked at runtime at all despite being
  string-interpolated into the `su -c '...'` body executed as root on the
  device. `src/shared/tracer-caps.ts` now exports `validateStartRequest`,
  called at the top of the `tracer:start` handler.

## Shipped (2026-07-23) - Capture: two-engine scope, repeatable library filters, mandatory preflight

`syscalls` and `funcs` are now the only two engines the Capture modal exposes -
the only two whose output the desktop's JSONL parser can actually load.
`correlate`, `trace`, and `mod` are removed: `correlate` emits a `type: "func"`
record the parser does not recognize, `trace`'s `-o` is a filename *prefix*
that writes three separate files instead of one, and `mod` does write
structured JSONL via its own `-o FILE` flag, but its record types (`spawn`,
`proc_exit`, `execve`, `prop`, `file_access`, `massdelete_detect`,
`exfil_detect`, `accessibility_detect`, `fileless_detect`,
`screencapture_detect`) are none the parser recognizes - there is a file,
just nothing in it the parser can turn into a graph. Anubee also removed its `syscalls -a` capture-all
flag upstream; the desktop still emitted it, so every capture-all run died in
argp - fixed by making the library filter a repeatable, glob-capable chip list
(`-l` per selector, up to 64, OR'd) where an empty list *is* capture-all, no
flag needed. A glob-bearing selector is additionally single-quoted inside the
`su -c` body so the device shell cannot expand it against its own cwd before
anubee ever sees it. Preflight is now mandatory: the footer's primary action
is `Preflight` until every check passes, then `Start capture`; any config edit
marks a passed or failed result stale and reverts the footer to `Preflight`,
since preflight both validates the target package and pushes the binary and
specs dir. A live command preview shows the exact `su -c '...'` string that
will be dispatched. See `DOCUMENTATION.md`'s "Tracer control" section.

### Deliberately left unexposed
- `-x` denylist, `-e` / `-F` probe specs on `syscalls`, `-A` activity
  override, and `-q` have no form control.
- `-p` PID-attach mode (`--siblings` / `--no-follow-fork`) has no form
  control; adding it needs a `-P`/`-p` mode switch plus PID discovery, not
  just another flag bolted onto the current package-driven form.
- Re-adding `correlate` needs the JSONL parser to learn `type: "func"`
  records. Re-adding `trace` needs a multi-file pull
  (`<prefix>.syscalls.jsonl` / `.funcs.jsonl` / `.lib.jsonl`) instead of the
  current single-file pull.
- Mandatory preflight costs an adb round-trip after every config edit.
  Acceptable today (preflight is fast against a reachable device); revisit if
  the check set grows enough to make that round-trip noticeable.

### Known drawbacks / follow-ups
- **The running view's argv preview shows a placeholder, not the real path.**
  `paintArgv` composes the running-state command preview with a hardcoded
  `<out>.jsonl` in place of the real path, because the actual `-o` path is
  timestamped at dispatch time in main and never surfaced back to the
  renderer. The preview is otherwise byte-accurate to what was dispatched.
  Wire the resolved path back over the existing `tracer:start` round-trip (or
  a dedicated event) to close this.
- Per-line `tracer:line` IPC and DOM append are still unbatched under
  sustained high line rates - see the "Capture footer fast path" entry below;
  that fix removed the footer-rebuild cost but not this one.

## Shipped (2026-07-22) - CoverageEvent schema drift fix

The vendored `CoverageEvent` type required `snaps`/`cfi`, but the emitter
(`../Anubee/src/common/coverage.c`) writes three shapes - exempt, clean,
degraded - each with its own conditional fields; a `clean` or `exempt` record
(or any run captured without `--snapshot`) had `snaps`/`cfi` absent, so
`main.ts`'s `cov.snaps.total` threw an unhandled `TypeError` and silently
killed the coverage chip. Fixed: the vendored type now makes every field
optional and models the fields the emitter actually writes; the chip is built
by the new pure `coverageChipText` (`src/renderer/coverage-chip.ts`), which
composes whichever fields are present and adds a `.catch()` as a backstop.
The DuckDB ingest schema (`COLS` in `graph-store.ts`) was also widened -
without it, `read_json`'s explicit-columns read silently drops any JSON key
not listed, so the new fields would ingest without complaint but never reach
the renderer (confirmed live: a real no-`--snapshot` run produced a
`prearm_drops`-only degraded record that the old schema would have dropped
entirely). `tests/schema-drift.test.ts` now guards `coverage` record keys
against the sibling `../Anubee` checkout, the same way syscall/backtrace keys
already were. See DOCUMENTATION.md's "Coverage/truncation chip" section.

## Shipped (2026-07-22) - Capture footer fast path (per-line footer rebuild)

`captureLineSink` (`main.ts`) no longer calls `paintFooter()` per console
line - it patches the counters text node directly via `setFooterCounters`
(`capture-footer.ts`), instead of `renderCaptureFooter` tearing down and
rebuilding every button and click listener on every line (an unfiltered
`syscalls` capture emits thousands of lines/sec, so this was thousands of
full footer rebuilds/sec). `appendConsoleLine` (`capture-view.ts`) now caps
the console DOM at 5,000 lines (oldest dropped first); the footer counter is
tracked independently of the (capped) DOM count, so it still shows the true
running total past the cap. See DOCUMENTATION.md's "Tracer control" section.

### Known drawbacks / follow-ups
- **This fix bounds memory, not the underlying per-line cost.** Live-tested
  against a real device: an unfiltered `syscalls` capture against a busy
  target can still keep the renderer's main thread busy for an extended
  stretch processing the backlog of individual `tracer:line` IPC messages +
  DOM appends - the fix removes the footer-rebuild cost (confirmed ~5x
  cheaper per line in an isolated benchmark) but does not batch or throttle
  the line stream itself. If sustained high-rate unfiltered captures turn out
  to need it, the next step is coalescing `tracer:line` delivery (e.g. flush
  accumulated lines once per animation frame) instead of one IPC round trip +
  DOM append per line.

## Shipped (2026-07-21) - Loading feedback wired into open-run and record-select flows

Every load path now speaks one loading language instead of ad-hoc spinners:
opening a run raises the top bar as a determinate, EWMA-estimated fill
(`ingest.begin`/`phase`/`end`/`fail` in `src/renderer/loading-ui.ts`) plus a
table skeleton; selecting a row raises the same bar as an indeterminate sweep
plus a graph overlay spinner (`graph.begin`/`end`), guarded by the existing
`selEpoch` so a superseded selection cannot clear the loader out from under
the selection that replaced it. Success is silent (bar fills and clears, no
toast); failure flashes the bar red, shows a `Failed to load: ...` toast, and
restores the "No run loaded" empty-state. The old `#ingest-progress`/
`#ingest-bar`/`#ingest-pct` DOM handler is removed from `main.ts` (the
`onProgress` preload bridge is left in place, unused, since `trace:progress`
still fires from the store). See `DOCUMENTATION.md`'s "Loading feedback"
section.

### Known drawbacks / follow-ups
- **Graph loader has no duration predictor.** `graph.begin()` always raises an
  indeterminate sweep - there is no equivalent to the ingest EWMA estimator for
  a graph-slice fetch, so even a large, slow slice never shows a determinate
  fill. Add a size/row-count-based predictor if graph fetches on very large
  runs turn out slow enough to want a real progress read.
- **Manual GUI smoke deferred.** This session's sandbox cannot launch
  Electron (no GPU/display); the wiring is typecheck- and full-suite-clean but
  the interactive open/select/fail/rapid-click behavior described above still
  needs a live pass.
- **Silent 0-event load on a garbage-but-readable file.** DuckDB `read_json`
  runs with `ignore_errors=true`, so a readable file with no valid JSONL records
  parses to 0 events WITHOUT throwing. `store.ingest` resolves normally, so
  `trace:fail` never fires and there is no error toast - the load just shows an
  empty run. Not covered by the centralized failure path; needs a separate
  "0 events parsed" guard if this should surface as a warning.
- **`trace:progress`/`onProgress` IPC is now dead.** The old
  `#ingest-progress` handler was removed, so no renderer code subscribes to
  `onProgress`, yet main's `ingestPath` still emits `trace:progress` per line and
  the preload bridge is still exposed. Candidate for removal on both ends.

## Shipped (2026-07-20) - Omni-filter dotted key redesign

The omni filter's `key:value` grammar moved to a dotted namespace: `lib:` ->
`stack.lib:`, `module:` -> `fn.lib:`, `symbol:` -> `fn.sym:`, and `java:` ->
`java.exist:` (hard renames, no aliases - the old keys now fall through to free
text). New keys: `id:<N>` / `id:<A-B>` (exact record id / inclusive range),
`java.method:<sub>` (Java-stack method substring), `stack.sym:<sub>` (native
backtrace symbol substring), `tag.exist:yes|no` and `tag.name:<category>`
(record reaches / does not reach a confirmed-tagged node, optionally scoped to
a RASP category). Full key table in `DOCUMENTATION.md`'s "Command bar"
section.

### Known drawbacks / follow-ups
- **`tag:` filter deferred coverage.** `tag.exist:`/`tag.name:` only match
  `sys:`/`nat:`/`java:` node tag targets per record; edge (`edge:src=>dst`) and
  funcs-callee (`fn:`) tag targets are not yet matched. The resolver buckets
  live in `src/shared/tag-targets.ts` (`resolveTagTargets`, which already
  ignores `edge:`/`fn:` targets); the SQL predicate is `tagPredicate` in
  `src/shared/filter.ts`. Extending either requires adding an edge-target and
  a funcs-callee-target bucket to both.
- **Latent CFI-managed java tag round-trip gap.** The `tag:` filter's java
  matching queries `java_stack` (flat dotted method names, offset-stripped)
  against tagged `java:` targets. But CFI-managed java node ids built by
  `cfiNodeId` in `src/shared/graph-shape.ts` strip a `Class!method` prefix
  (`^.*!`) in addition to the offset. So a tag created on a CFI-managed node
  whose symbol carried a `!` prefix resolves to a bucket value that a flat
  `java_stack` row can never equal - the tag filter would silently return zero
  rows for it. Latent today (no CFI/managed-stack fixtures exist; current
  `java_stack` samples are plain dotted names); resolve when CFI java support
  lands, alongside the edge/fn deferral above.

## Shipped (2026-07-20) - Node-inspector pagination + offset-popup histogram

The right-panel node inspector now pages the records behind a tapped node in
windows of 100 with a prev/next arrow pager mirroring the master table
(`buildInspectorPager`, `.pager.insp-pager`); the header pill shows the node's
true total via a new `nodeEventCount` store query rather than a capped page
length. `main.ts` owns the paging state (`nodeOffset`, `currentNode`,
`refreshNodeInspector`), the right-panel analogue of `tableOffset`/`refreshTable`.
Both engines paginate (`showNodeInspector`, `showFuncsNodeInspector`). The
native-node offset popup became a read-only per-syscall histogram
(`aggregateBySyscall`): rows are aggregated by syscall (`syscall` + summed
`count`, sorted count-desc then syscall-asc), dropping the offset column, the
row-click inline detail, and the right-click Copy menu - the per-record offset
now lives in that record's detail card. See `DOCUMENTATION.md`'s "Offset popup"
and "Detail panel redesign" sections.

### Known drawbacks / follow-ups
- **Orphaned shared helpers.** `copyText` / `rowJson` (`src/shared/origins.ts`)
  and the `sampleEventId` plumbing were the offset popup's only production
  consumers; after the Copy / row-expand removal they are referenced only by
  their own tests. Left in place deliberately - `origins.ts` documents them as
  shared with the "(later) Session MCP", so they are intended future API, not
  dead code. Delete if the Session MCP work is dropped.
- **Highlight can be dropped by very fast paging.** `onPrev` / `onNext` bump
  `selEpoch` (needed so an out-of-order page can't paint over a newer one),
  which also invalidates the original tap's still-in-flight `highlightSets`
  continuation. Clicking next/prev before that resolves on a large run means the
  node's graph highlight silently never applies. Same node, so cosmetic only.
- **Offset-popup empty-state wording.** The empty note still reads "no
  call-sites in the current filter", phrased for the old per-offset table rather
  than the new per-syscall histogram. Cosmetic.

## Shipped (2026-07-20) - Row-select auto-highlight + graph-scoped highlight/details

Selecting a master-table row now lights that record's own call path
(java -> native -> syscall) on the freshly rendered bridge graph immediately,
with no node click needed (`recordChain`, `setsFromChain`); the rest of the
bridge stays dimmed until a node is tapped. Tapping a node still re-lights the
backtrace-accurate co-occurrence set through it, but that highlight and the
node's detail records (`nodeEvents`, `nodeOffsets`) are now both scoped
strictly to `graphFilter` - the filter the rendered graph was actually drawn
with - rather than the master table's live filter, which can drift out of
sync with what's on canvas. See `DOCUMENTATION.md`'s "Row-select
auto-highlight" and "Backtrace-accurate selection highlight" sections.

### Known drawbacks / follow-ups
- Graph highlight cap-connectivity: `highlightSets` is uncapped while the slice is
  capped at `GRAPH_SLICE_CAP` (1500) nodes in GROUP BY order. When a single bridge
  exceeds the cap, a highlighted node can reference a cap-dropped intermediate and
  render disconnected again. Rare (bridges are small); resolve alongside the
  deferred per-interaction chain-rebuild / cap-connectivity performance work.

## Shipped (2026-07-18) - Opt-in tid/retval columns + full-args record detail

The syscall engine's `tid` and `retval` columns are now catalogue-only by
default: offered in the `⚙ columns` picker (both stacked and split mode) but
excluded from the default-visible set until an analyst opts in
(`src/renderer/columns.ts`). The record-detail Args card now lists every raw
`arg[i]` in index order, with each decoded `string`/`decoded`/`fd` overlay for
that index rendered as an indented sub-row directly beneath its own arg slot
(`interleaveArgRows`, `src/renderer/inspector.ts`), rather than the raw args
and each overlay group listed as separate flat lists. See `DOCUMENTATION.md`'s
"Master table columns" and "Detail panel redesign" sections.

### Known drawbacks / follow-ups
- **`interleaveArgRows` has no cap on its loop bound.** The upper bound of its
  render loop is derived from the largest numeric key across the tracer-supplied
  overlay maps (`string_args`/`decoded_args`/`fd_args`), with no ceiling - a
  malformed or adversarial record carrying a huge numeric overlay key would
  drive a large synchronous loop on the render thread for that one record.
  Clamp the derived `max` to a sane ceiling if untrusted/malformed captures
  become a real input source.

## Shipped (2026-07-18) - Startup splash + gold brand accent

A frameless logo splash window (`src/renderer/splash.html`) shows on launch
while the main window loads behind it, held for a ~600ms minimum so a fast
load doesn't flash-and-vanish; `ANUBEE_NO_SPLASH` skips it for the screenshot
harness/E2E. The brand accent moved from war red (`#c8322b`) to the logo's
amber-gold (`--accent` `#c9a24a` dark / `#b0812e` light), with a new
`--accent-ink` (`#17140d`) token for text on solid-gold fills (primary
buttons, the capture form's section badge, segmented-button active states).
The rail brand mark is now the vendored `assets/logo.svg` image rather than
the earlier inline-SVG `A`-mark. Semantic colors (kind/RASP/warn) are
unchanged. See `DOCUMENTATION.md`'s "Startup splash" and "Theme" sections.

### Known drawbacks / follow-ups
- **Splash progress bar is indeterminate.** It's a decorative CSS animation,
  not wired to real DuckDB ingest progress - a long first load gives no
  signal of how far along it is. Wire it to the same `onProgress` events that
  drive the empty-state ingest bar.
- **Full logo reads soft/muddy at the 22px rail size.** The rail brand mark
  scales the full `assets/logo.svg` down to 22px, where the mark's fine detail
  doesn't hold up at that size.
  Draw a purpose-simplified small jackal mark for the rail (and any other
  sub-24px use) instead of scaling the full logo.
- **Wordmark still sets in Inter.** "Anubee" in the rail brand slot and the
  splash card uses the same Inter font as the rest of the UI; a dedicated
  Anubee logotype/font for the wordmark is deferred.

## Shipped (2026-07-17) - Native Libraries live-device fixes + Anubee rename

Fixed the "Live device" mode end to end. Two fixes live in the tracer
(`../Anubee`, merged there): `dump --base` now range-matches any address inside
a module - so the executable-segment base the `[lib]` stream reports (what the
viewer shows and sends) is dumpable - and stdout is line-buffered so `[lib]`
lines stream live under the `adb shell` pipe instead of flushing only on Stop.
Desktop side: `triageDir` locates the pulled `.so` by the manifest `path`
basename (`<name>.<pid>.<basehex>.so`) not the module name, so the "Dumped
artifacts" tab renders; and `Verify` runs an on-demand `dump --now --check` so
it works on a stopped capture. All device-verified except the Desktop E2E (see
below). Host suite green (576).

Follow-ups (resolved in a later pass, same day):
- **`DEVICE_BIN` -> `/data/local/tmp/anubee`** done, with `STOP_ARG`, the stop
  pkill patterns, and the device/host temp-dir + run-file prefixes; test
  expectations updated (`src/shared/tracer-caps.ts`, `src/main/{index,tracer-control}.ts`).
  Device-verified. NOTE: the on-device `/data/local/tmp/anubee` is currently a
  copy of the pre-rename fixed binary (Docker was unavailable to build the
  renamed one); the app's own preflight md5-push, or a `make push` from
  `../Anubee`, replaces it with the real build.
- **Desktop device E2E** done: `dumpByBase` and `checkByBases` driven against a
  real device through the actual main-process code path (dump renders an
  artifact; post-stop verify returns a verdict). Only the thin Electron
  IPC/renderer glue remains unit-test-only.
- **Sidecar extension** now writes `.anubee-desktop.json` and still reads legacy
  `.anubee-desktop.json` (backward compat; migrates forward on the next save), so
  pre-rename sidecars shared between users keep loading.

Remaining / open (carried from this session):
- **Real renamed tracer binary not built.** On-device `/data/local/tmp/anubee`
  is a copy of the pre-rename fixed build (Docker was unavailable this session).
  Build from `../Anubee` and `make push` (or let the app's preflight md5-push
  replace it) to get the genuinely renamed binary on device.
- **Anubee-Detector not audited.** Only its folder + git remote were renamed;
  its *content* was not reviewed for `../Anubee` refs or Anubee branding. It also has
  an untracked `kls_database.db`.
- **Desktop rebrand pass (the theme + name work now in progress).** ~50 tracked
  files still carry `anubee`/`Anubee`. Not yet swept:
  - `package.json` - `name` (`anubee-desktop`), `build.appId` (`com.anubee.desktop`),
    `build.productName` (`Anubee`).
  - `@shared/anubee-parse` module filename + all its imports.
  - `src/renderer/index.html` + `theme.ts` - palette tokens / logo / brand naming
    (this is the styling change being done now).
  - README / DOCUMENTATION / TESTING prose, test temp-dir prefixes
    (`mkdtempSync('anubee-*')`), and the example fixture
    `tests/fixtures/detector_snap.jsonl.anubee-desktop.json` (still the legacy
    sidecar extension - read via fallback - and carrying unrelated uncommitted
    edits left untouched).
  - Checklist: `git grep -il anubee`. **Do NOT rename** `dev.anubee.detector` or
    `libsentinel.so` - exempt reference-app identifiers (project privacy rule).
- **Verify/dump ipcMain glue is unit-test-only.** The thin Electron handlers
  (`nativelib:verify`, `nativelib:dumpLib`) aren't integration-tested; covered
  indirectly by the device E2E of the underlying `dumpByBase`/`checkByBases`.

## Shipped (2026-07-16) - Brand palette + logo integration

Recolored the whole app to the Anubee logo palette (war red / night / bone) and
dropped the `A`-mark into the left-rail brand slot + the window/builder icon.
Chrome, kind colors (reharmonized warm), RASP categories, log lines, and flame
neutrals all moved; single-source tokens in `index.html` `:root` + `theme.ts`.
See `DOCUMENTATION.md` "Theme".

Known follow-ups (deliberately out of scope this pass):
- Graph badge border for non-native badged nodes is still the old purple
  `#8e44ad` (`src/renderer/main.ts`) - a generic RASP marker, not a kind/category
  color, so left as-is; retune into the warm family if it reads off-brand.
- App icon is wired for `--linux dir` (`build/icon.png`) only; Windows `.ico` /
  macOS `.icns` build inputs not set up (assets exist in `../assets`).

## Shipped (2026-07-16) - Native Libraries Phase 4 (header layout A + tabbed dock C1)

Gives the Libraries view its final chrome. The header is now three
single-scope strips: a session toolbar (title, Loaded run / Live device
segmented control, and the live dot/package/Stop or Start live capture...),
a status stat row (`N mapped · M modified · K unmapped`, or `N libraries` in
Loaded mode), and a contextual selection bar that renders only when rows are
ticked and hosts Dump / Verify / Clear - no disabled buttons, an action is
present because it applies or absent entirely. Verify moved out of being a
bare live-only control (Phase 3) into that selection bar, alongside Dump and
Clear; a click after a live stream has stopped now logs a `verify needs a
live stream` line instead of silently no-op'ing.

The separate artifacts dock and device-log dock merged into one tabbed dock -
`Dumped artifacts (n)` / `Device log (n)` - collapsed and expanded by a single
chevron (the tabs only ever switch panes, never collapse), and resizable via
a drag grip that exists only while expanded. Dragged height, collapse state,
and the active tab persist to `localStorage` through the pure
`src/renderer/lib-dock-layout.ts` module and restore on remount. An error
line in the device log red-dots the log tab and auto-expands a collapsed dock,
but never steals the active tab away from whatever the analyst is looking at
- the same error regex also matches non-fatal chatter, so forcing focus would
cost more than the alert is worth. Full detail in `DOCUMENTATION.md`'s
"Native Libraries" section.

### Known drawbacks / follow-ups
- The merged tabbed dock trades simultaneous artifacts+log visibility for
  cleaner chrome: the device log and the dumped-artifacts table can no longer
  be read at the same time, only one tab is visible at once. The red dot
  covers *noticing* an error in the log, not *correlating* it with a specific
  dumped artifact while looking at both. A split or side-by-side dock view
  could be added later on top of `lib-dock-layout.ts` without redoing this
  work - the pure layout module already tracks height/collapse/active-tab
  independently of the DOM.
- The GUI end-to-end path for this chrome (grip drag, chevron collapse,
  selection-bar show/hide, red-dot auto-expand) is unit- and
  harness-tested, never driven through a live device pass - same
  device-verification gap carried forward from Phases 1-3.

## Shipped (2026-07-16) - Native Libraries Phase 3 (integrity tags + check batching)

Replaces the Phase 2 `isNew`/`NEW_LIB_SETTLE_MS` heuristic (which flagged every
row, since a cold-start linker burst lands well past its 1500ms mark) with a real
integrity signal. Every dumpable row that maps during a live stream is
auto-queued into a 300ms debounced batcher, coalescing the whole map burst into
one `anubee dump --now --check -p <pid> --base A --base B ...` pass (`--base`
repeats; sliced above Anubee's 64-base cap). Returned `modcmp` verdicts join back
to table rows by `pid` + numeric base (never by module name - an APK-embedded
library's `modcmp` module is literally `base.apk`) and render as `MODIFIED`
(`differ`) or `NO FILE` (`nofile`); `match`, `apk`, and `unreadable` are
deliberately withheld from a badge so a read failure or an unresolved APK
baseline never reads as a false modification. Because every library is
baselined at map time, a clean-to-modified transition is observed and recorded
on the row (`clean at t+Xs -> modified at t+Ys`), not inferred. An on-demand
**Verify** control re-runs the same batched check for the ticked selection or
every dumpable row. Full detail in `DOCUMENTATION.md`'s "Native Libraries"
section.

Device-verified (`dev.anubee.detector`, Phase 1 binary): `anubee dump --now --check`
against the APK-embedded `libsentinel.so` (maps path `base.apk`) returned
`state: match` with `mem_sha256 == file_sha256`, confirming the false-MODIFIED
guard holds on a genuinely clean library and that the `pid|base` join is
necessary on real hardware (the modcmp `module` field really is `base.apk`, not
the library name). A batched three-base pass in one invocation returned three
`match` verdicts, validating repeatable-`--base` batching end-to-end. The device
pass does not exercise the `differ` (unpacking) path or the GUI path - see
below.

### Known drawbacks / follow-ups
- The on-demand Verify control is minimal (live-only, no selection-aware placement); its polished home is the view header, planned for Phase 4 (spec 7.1).
- `DT_TEXTREL` / JIT libraries legitimately read `MODIFIED` - the honest cost of naming the observation rather than an inferred cause. Documented, not worked around.
- The real `clean -> differ` (unpacking) transition is not proven end-to-end on a device: no self-modifying / packed fixture exists in `../Anubee-Detector`. Host tests cover the differ path on synthetic images; the device pass proves only `match`. Same gap as Phases 1/2.
- The GUI end-to-end path (badges rendering in the running Electron app, the Verify button, the 300ms debounce timing) is unit-tested only, never driven through Electron. The device pass above was CLI-level. Same carry-forward as Phase 2.
- `startLive` eagerly `mkdir -p`'s the check device dir up front; `checkByBases`'s first slice `mkdir -p`'s the same dir again internally. Redundant but harmless - `mkdir -p` is idempotent.
- The Verify control stays visible after the stream stops (its `hidden` gate is `source !== 'live'`, not streaming state); a click on a stopped-but-still-Live table hits the `nativelib:verify` early return (`liveCheckDir` is nulled at teardown) and silently does nothing - no log line, no feedback. Cosmetic; the control's streaming-aware placement is Phase 4's job (spec 7.1).
- The evidence trail's baseline timestamp is the row's map time (`atMs`), not the time the baseline verdict was actually recorded - so "clean at t+4.3s" is when the library mapped, not when it was first checked. Deliberate anchor (matches the DOCUMENTATION example), consistent, but slightly imprecise as "when clean was observed."

## Shipped (2026-07-15) - Native Libraries (lib + dump)

A third view mode (Libraries, next to Graph/Flame) with a Loaded-run <-> Live-device
source switch and a collapsible bottom artifacts dock. Loaded mode reads retained
`type:lib`/`unlib` records via `GraphStore.libTable` (unlib flags unmapped frames).
Live mode streams `anubee lib -P <pkg>` stdout parsed by `src/shared/lib-line.ts`,
stamping each library with host arrival time and flagging post-setup loads (after
`NEW_LIB_SETTLE_MS`, 1500ms) as `new` - the packer-decrypt signal. Dumping snapshots
an exact `pid|base` selection via `anubee dump --now -p <pid> --base <addr>`,
attaching no BPF and exiting 0 on success, then pulls the output dir + manifest
and triages each `.so` via `src/shared/elf-triage.ts` (ELF magic/arch/sha-256/size).
Reveal opens the file manager; Export saves a copy. `lib` and `dump` are no longer
selectable engines in the Capture modal.

### Known drawbacks / follow-ups
- Loaded-mode `new-since-start` is not shown (no wall-clock in the `lib` JSONL); the badge is live-mode only. Loaded rows show ingest sequence.
- soname is taken from the `lib` record / dump manifest module name, not parsed from the dumped ELF's `DT_SONAME`.
- Packer-proof hash-vs-on-disk compare is deferred (needs also pulling `/data/app/.../lib/<abi>/<name>.so`).
- Live stream + dump use the default adb device; multi-device `-s` selection is deferred (matches the rest of the app).
- Two concurrent anubee processes (lib stream + `dump --now`) - device-VERIFIED (`dev.anubee.detector`): a `dump --now -p <pid> --base <addr>` run against an APK-embedded library (maps path `base.apk`) completed with `DUMP_EXIT=0` while the separate live `anubee lib` stream pid kept running underneath it (unaffected), and the target app process survived. The pulled artifact rebuilt as a valid arm64 ELF. `dump --now` acceptance by anubee' argp is confirmed; no stop-then-resume workaround is needed.
- The on-map watcher's file-path-only boundary is a maps-path limitation in anubee' `-l`, not a Desktop bug: it matches the resolved `/proc/<pid>/maps` path of a mapped library, so it can only ever catch a file-backed transient. It cannot match an APK-embedded library (maps path is `base.apk`, there is no standalone file it decrypted to) or an anonymous mapping (no path at all) - those remain reachable only through the table (once mapped) or by dumping their base directly.
- The on-map watcher was NOT fired against a real transient on device: `dev.anubee.detector` has no decrypt-to-a-file-then-`dlopen` payload, and its libraries are APK-embedded, which on-map cannot match by design (see above). What IS proven: the built command delivers the glob literally through `su -c` (measured on device), and its stop pattern is the same anchored form verified for the live stream. For the same reason, the pull-and-triage-into-the-dock path added after this bullet was written (own device dir, pulled + triaged into the Artifacts dock on stream stop) is likewise unverified on device - it is covered by unit tests only. Closing this needs a target that maps a file-backed transient library.
- The GUI live+dump path has still not been driven end-to-end through the app UI; the device pass above was at the CLI level, exercising the exact strings the Desktop builds directly over adb, not through Electron.
- Check-batching and the `MODIFIED`/`NO FILE` tags on repeated dumps were Phase 3, not this drop - see the 2026-07-16 section above.
- `startLive` has no double-start guard in the main process: invoking it while a stream is live still orphans the previous RunHandle. The renderer now closes both practical paths - the header hides "Start live capture" while streaming, and leaving Live mode calls `stopLive` - so this is defence-in-depth only, not a live risk today.
- Live-stream and dump stdout share the single `nativelib:line` IPC channel; lines interleave if a dump is fired mid-stream.
- The Libraries view re-fetches `libTable` on every tab click (cheap - lib records are sparse).
- Pre-existing (not introduced by this feature): the `#tab-left` collapse float button clips the leading text of the Flame view's truncation banner, the same overlap the Libraries header fix resolved for its own view.
- GUI smoke was via `npm run shots` against the loaded fixture (`10-libraries.png`); the live-stream + dump path has a CLI-level device pass (see above) but still needs to be driven through the GUI itself.
- The Libraries preflight modal shares the `tracer:preflight-check` IPC channel with the Capture modal; both listeners fire on any preflight and each no-ops when its own surface is closed. Harmless today, but a per-caller channel would be cleaner if a third caller appears.
- The live preflight modal's shape is asserted by `npm run shots`, but a green preflight + streaming run still needs an on-device pass (no device in the harness).
- Capture's stop still uses the old global `STOP_ARG` kill switch (`startRun`'s default, `activeRun.stop()` in `src/main/index.ts`), so stopping a Capture run can still SIGINT a concurrent Libraries live stream or on-map watcher. Deferred because Capture's cmdline can carry an optional `timeout -s INT -k 3 <N>` wrapper (e.g. `su -c 'timeout -s INT -k 3 20 /data/local/tmp/anubee syscalls -P dev.anubee.detector -l libc.so -o ...'`), so a scoped Capture stop pattern needs to match both the wrapped and unwrapped shapes, not just an anchored `^/data/local/tmp/anubee syscalls ...`.

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
project bundle (`.anubeeproj.json`, `src/shared/project-file.ts`) lets Save
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
  `tests/fixtures/detector_snap.jsonl.anubee-desktop.json` (the tracked example
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
under `anubee.columns.<engine>` alongside the column set + mode). The graph pane
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
preflight) by level; Save writes `anubee_<date>_<time>.log`; Clear empties it.
Load progress moved to a thin bar on the empty-state. `log-store` (pure ring
buffer), `run-logged` (action wrapper), `log-view` (modal).

### Known drawbacks / follow-ups
- **Failed rule saves are not logged.** Rule logging hangs off `renderRules`'
  `onChange` (fires only after a successful save), and `rules-view.ts` was left
  untouched, so a *failed* rule save produces no `error` entry. Instrument the
  `rulesSave` call sites directly when rule-save failures need surfacing.
- **Ingest progress bar can stick on a failed first load - RESOLVED 2026-07-21.**
  `onProgress` showed the bar and only `onLoaded` hid it; if a first ingest
  errored before it completed, the bar stayed. Now main's `ingestPath` sends
  `trace:fail` on any ingest error and the renderer's `onIngestFail` calls
  `ingest.fail`, clearing the bar/skeleton/toast for all four broadcasting load
  paths (see "Shipped (2026-07-21) - Loading feedback" above).
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
per engine (`anubee.columns.<engine>`, legacy `anubee.columns` = syscall fallback).
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
- **`retval_str` unused.** Anubee emits a decoded `retval_str` for funcs; the
  inspector shows only the numeric `retval`. Consider surfacing it for
  pointer/handle-returning funcs.

## Shipped (2026-07-13) - funcs engine support, Phase 1

Loads `anubee funcs` runs: engine detection at ingest (`RunInfo.kinds`), a funcs
master-table list (function / caller / retval / elapsed / args) with retval/elapsed
folded from the matching `return` by shared `id`, and a deep unified
function-to-function call graph built in SQL (`FUNCS_CHAIN_SQL`, replaces the old
JS `funcsAdapter`) verified against the `foldFuncEvents` oracle. Off-heap and
`span IS NULL`-guarded throughout.

### Known drawbacks / deferrals from funcs Phase 1 (to resolve later)
- **GUI smoke test pending on a fresh capture.** Core logic is covered by unit +
  integration + lockstep tests, but the interactive Electron smoke (funcs columns
  render, row-click draws the gold `fn:` graph) was not run: the committed
  `../anubee-detector-funcs-sample.jsonl` predates the tracer's `id` field, so it
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
  run carries `lib` records, which the Anubee tracer emits on `mmap` during the
  trace. A snapshot or post-load capture has no `lib` records (modules already
  loaded at attach time), so all offsets show `[unmapped]`. The durable fix is
  Anubee-side: prime the module map from `/proc/<pid>/maps` at attach time so
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
  corrected/extended, validated against the real 245,760-event Anubee-Detector
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
  persistence (`<run>.anubee-desktop.json`), tag editor + node badges + table tag
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
- **Rule-engine SQL/JS lockstep** (mental note for the next Anubee-version bump) -
  `compileWhere`/`scoreWith` must stay in agreement on every rule's semantics
  (in particular hex-arg formatting, e.g. Anubee's `jb_hex` always emitting
  `"0x0"` for a zero request); this is covered by a real-DuckDB lockstep test,
  not by `tests/schema-drift.test.ts` (which only checks field names). Re-run
  the lockstep test whenever the vendored Anubee schema version is bumped.
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
  keys from `../Anubee/src/syscalls/syscalls.c`. If the emitter is refactored to
  build keys non-literally, the scrape breaks - revisit to parse `trace_schema.h`
  instead. Test must skip cleanly when `../Anubee` is absent.

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
  the capture form's stack-snapshot toggle makes Anubee write a native
  `<out>.jsonl.stacks` sidecar (raw CFI stack snapshots for off-device DWARF
  unwinding) next to the pulled `.jsonl`. The desktop pulls only the `.jsonl`
  and has no in-app CFI/DWARF unwinder, so the sidecar is left on device. The
  Java-frame payoff still lands inline in the `.jsonl` (that path does not need
  the sidecar); native off-device unwinding would need a separate unwinder.
- **`trace` capability argv is rejected by anubee.** The `trace` cap builds
  `trace -P <pkg> -F <spec>`, but the real `trace` engine
  (`../Anubee/src/trace/trace_args.c`) accepts only `-P/-p/-A/-o` plus section
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
  user, not discovered from `anubee mod --help`. Parse the analyzer list at
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
  analytics + device tools stay in `tools/anubee-mcp`.
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
- The original Phase-1 plan built an **in-memory `AnubeeGraph`** and `postMessage`d
  the whole parsed-event array worker→main. Replaced 2026-07-03 by the DuckDB
  store (spec §5) because that path OOMs V8 on multi-GB runs and re-scans every
  event per filter. Do not reintroduce a full in-heap event array.

# Changelog

All notable changes to `dsh-layers-hippocampus` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

## [1.6.0] — 2026-11-06

**Version un-frozen (user directive 2026-11-06): 1.6.0 is the current release.**
Cold-start wake-up + user-controlled cold-start injection:

- **Anti-"customer service" wake-up** (static `memory:policy` prefix): the model is
  told it has continuous long-term memory, must not open with "how may I help you",
  and should recall the recent topic before replying.
- **`context.coldStartInjectSummary`** (default **true**): on the first prompt
  assembly of a brand-new conversation, inject `[Cold-Start Summary]` — the handoff
  summary event when present, else the top-3 L3 semantic summaries (≤800 chars).
- **`context.coldStartInjectRecentTurns`** (default **false**): inject
  `[Previous Context Tail]` with the last ≤5 business episodes (200 chars each).
- **`[Cold-Start Detected: Active Space=…, Recent Topic=…]`** header when either
  switch is on; the block is volatile-tail only (prompt-cache prefix untouched) and
  is consumed exactly once per new conversation.
- Both switches off → no historical blocks; the static wake-up policy still ships.
- UI: two independent toggles in the settings page's session group; HTTP-editable.
- **416 tests green** (64 files).

## [1.5.7] — 2026-11-04

> Historical note: 1.5.7 shipped under a temporary version freeze that the
> 2026-11-06 directive superseded (current version: 1.6.0).

**Version freeze: 1.5.7 is the shipped release; no further version bumps follow.**
This release folds in everything added after the 1.5.6 draft — Orchestrator
federation/dedupe wiring, read-time merge, cross-space recall aggregation (opt-in
`features.crossSpaceRecall`), durable Orchestrator state, the settings-page GitHub
installer, the verified automatic new-conversation handoff (with configurable
once/interval detection), low-valley Dream Phase 2, space deletion, graph
interaction, and the rest of the 1.5.6 section below. Annotations of the form
`v1.5.6:` below record the version in which a feature was introduced; they are
history, not the current version. **411 tests green** (64 files).

## [1.5.6] — 2026-11-03

**`deep_raw` now scans by line cursor: a huge day shard is never loaded whole.**
The black box is read newest-first in fixed chunks; peak memory is one chunk plus
one partial line (test-locked), not the file size. `hit.line` keeps its absolute
1-based semantics. **411 tests green** (was 303).

### Changed — raw scan / restore (zero-dependency, O(chunk) memory)

- **`readLinesReverse(file, {chunkSize, onBuffer})`** (`src/rawStore.js`): reads a
  file backwards in 64 KiB chunks, yielding one line at a time; the trailing
  newline does not produce a phantom empty line. `onBuffer` reports the live
  buffer size for tests.
- **`deep_raw` scan** rewrote the whole-shard `readFileSync + split` path:
  newest-first, one `JSON.parse` per line, line bytes counted as they are read,
  hit results collected per shard. `hit.line` is computed from the shard's line
  count via ONE extra bounded streaming pass, paid only when that shard produced
  a hit (so a miss costs no counting pass).
- **`restoreByHash`** streams forward via `readline`; **`_loadTombstones`** streams
  synchronously with a `StringDecoder` (multi-byte boundaries preserved);
  **`_hashesFor`** streams asynchronously (so `RawStore.capture()` is now async —
  only internal callers exist; the public `captureRaw()` contract is unchanged).
- **Engine-side result ceiling**: `MAX_SCAN_RESULTS = 500` caps one scan even if an
  embedder passes `limit: 5000`; `budget.maxHits` is reported, `truncated` is true
  when the cap is reached.
- **Observability**: `scanned.peakBufferBytes` exposes the largest buffer the
  scanner ever held (proves the memory bound).

### Added — stability hardening (same 1.5.6, no extra version bump)

- **Recall response cap**: `context.maxInjectTokens` (default 4000, 256–100 000,
  fail-fast) bounds the JSON one recall returns. `Memory.applyPayloadBudget()`
  keeps hits in rank order (the first is always kept), then semantic/temp summaries;
  a cut is loud: `truncated: true`, `payload: {maxTokens, estimatedTokens, dropped}`
  and a `payload-budget` note. Editable over HTTP and rendered in the settings page
  with a tooltip.
- **`Memory.close()` releases resources**: `RawStore.close()` clears the flush timer
  and synchronously persists queued turns before the log closes; `Memory.close()`
  then detaches the scheduler, clears oversized-tag hints and calls
  `IndexManager.release()` to drop the A/B views. Idempotent.
- **Event-loop lag monitoring**: `src/eventLoop.js` (`createLagMonitor`) wraps
  `perf_hooks.monitorEventLoopDelay`; `maintain()` yields 50ms between phases and
  `IndexManager.rebuild` yields between read/build/catch-up/swap once the measured
  max delay crosses 100ms. The report carries
  `eventLoop: {maxMs, p99Ms, meanMs, yields, thresholdMs}`. Honest boundary: a
  synchronous builder cannot be preempted, so the granularity is phase-level and the
  numbers expose an oversized phase.

### Added — pre-ingest tagging (same 1.5.6, no extra version bump)

- **`src/tagging.js` / `extractTags()`**: deterministic anchors derived from content
  shape — named error types (`error:typeerror`), Node errno codes
  (`error:econnrefused`), fenced-code language (`lang:python`), HTTP status
  (`http:500`), file path basename (`file:index.js`) and explicit task statements
  (`task:…`). No LLM, no dependencies, stable ordering.
- **Write gate** (`Memory.stage`): model-provided tags always win; only an untagged
  write runs the heuristic. Tags are deduplicated and capped by `tagging.maxTags`
  (1–5, default 2). Inferred anchors are recorded on `meta.auto_tagged` /
  `meta.auto_tags` (provenance, not a silent rewrite of what the caller asserted).
- **raw stays pure**: the black box still receives exactly
  `{turn_id, timestamp, role, content}` — the test locks the four-field shape.
- **Miss is a warning**: `MEM_E_AUTO_TAG_MISS` goes to the Host log via
  `Memory.setWarnHook` (wired in `index.js`) and increments
  `panel.autoTag.misses`; the write proceeds untagged.
- **Config**: `tagging.autoTag` (default true) and `tagging.maxTags` (1–5), both
  fail-fast, HTTP-editable and rendered in the settings page.

### Added — pinned memory (same 1.5.6, no extra version bump)

- **`remember({ pinned: true })`**: a lesson/experience that must survive time.
  It stores `meta.pinned = true` (provenance included in `content_hash`) and is
  refused with **`MEM_E_PINNED_TAG_REQUIRED`** unless the caller supplies at least
  one tag — an untriggerable lesson would be dead memory.
- **Never decays**: `projectEpisode` exposes `pinned`; `deriveTagTable` gives a
  pinned event `decay = 1`, keeps its tag un-archived, and protected from the
  `maxPostingsPerTag` drop; `deriveActiveSet` admits pinned tags regardless of
  score or the cap.
- **Ranks first**: recall gives every matching pinned record `decay = 1`, exempts
  it from `minScore`, and orders pinned hits ahead of all others
  (`pinned-first:N` note).
- **Observability**: `panel.global.pinned` counts pinned records.
- Tool surface: `memory_remember.pinned` (boolean) is documented and passed
  through; `bulk_ingest` items accept the same field.

### Changed — relevance-first prompt hints (same 1.5.6, no extra version bump)

- **Global "most active tags" map removed from the prompt.** `runtime.promptState()`
  now renders only tags that lexically overlap the CURRENT user turn (max 5), via
  `src/utils/memoryHints.js` (`selectRelevantTags` / `renderMemoryHints`).
  Internal bookkeeping tags (`status:*`, `month:*`, `context:*`, `active_task`)
  are never hinted; no match means the section is simply absent (no padding).
- **Cache-safe placement**: `[Memory Hints]` is rendered AFTER `[Memory Blocks]`,
  so a per-turn hint never disturbs the cacheable prefix (rules only).
- **Input source**: prompt assembly receives no message text, so the plugin tracks
  the last `user/message` from `session/event` (`runtime.lastUserText`); other
  surface events never overwrite it.
- The legacy `renderMemoryMap` / `composePrompt({map})` API remains for callers
  and is still unit-tested, but the plugin no longer injects the map.

### Added — capability flags & microkernel boundary (same 1.5.6, no extra version bump)

- **`features.multiSpace` (default true)** and **`features.crossSpaceTransfer`**
  (default mirrors multiSpace). Both are fail-fast, HTTP-editable and rendered in
  the settings page; turning multiSpace off implies crossSpaceTransfer off, and the
  explicit contradictory combination is refused.
- **Strict single-space mode**: with multiSpace off, every routed read/write whose
  `targetSpaceId` is not `default` answers **`MEM_E_FEATURE_DISABLED`** (before any
  I/O); `createSpace` / `ensureSpace` / `warmup` refuse too, and the `/spaces` route
  reports `['default']` with `capabilities.spaces=false` so the client hides
  create/selector affordances instead of 404-ing.
- **Tools follow the flags**: `space_transfer` / `transfer_to_global` are neither
  registered nor advertised in the prompt section when the capability is off.
- **`Memory.open('/abs/dir')`** is now the single-space form (the Orchestrator owns
  the multi-space walk); the options-object form stays supported.
- **`Memory.warmup({targetSpaceId?, dataDir?})`**: lazy, read-only index warm-up for
  the UI / Orchestrator — no maintenance, no writes; unknown/relative dataDir fails
  fast.

### Added — host lifecycle: compensating Dream (same 1.5.6, no extra version bump)

- **`src/hostBridge.js`** subscribes to the Host's process-local events
  `agent/created` and `session/created` (the "session start" signals) through a plain
  `{on, off}` bus seam, plus `agent/disposed` for teardown.
- **Compensation rule**: on a session start, if no Dream ran for
  `dream.compensateAfterHours` (default 24, 1–720, fail-fast) AND the price window
  permits, run exactly ONE compensating Dream through the shared
  `runtime.runMaintenance('compensate')` gate — never a second concurrent run, never
  a queue.
- **Price is injected, never guessed**: `setPriceProbe(fn)` / `DSH_DREAM_PRICE=low|high`.
  Unknown price + an LLM-backed Dream ⇒ skip (`price-unknown`); unknown + local-only
  Dream ⇒ allowed. A known peak ⇒ skip (`peak`).
- **Observability**: `runtime.hostStatus()` and `/stats`'s top-level `host` report
  `sessionStarts / compensations / skipped / lastSkipReason / dreamDue / lowValley`.
- `enableDream:false` disables compensation; `agent/created`/`session/created` do not
  otherwise affect memory writes (raw capture remains on `session/event`).

### Added — Dream tunables in the settings page (same 1.5.6, no extra version bump)

- The **safe** Dream subset is now exposed to `/stats` + `/config` and rendered in
  the settings page: `useLlm`, `minGroupSize`, `maxGroupsPerRun`, `maxSummaryChars`,
  `maxSourceChars`, `maxEventsPerGroup`, `llmTimeoutMs`, `failureThreshold`,
  `cooldownMinutes`, `compensateAfterHours` (all fail-fast validated).
- **Credentials stay private**: `dream.llm.{baseUrl,model,apiKey}` is neither exposed
  by the routes nor editable over HTTP nor rendered in the form; it comes only from
  the profile or `DSH_DREAM_LLM_*` env. A test asserts the key never appears in the
  `/stats` payload.

### Added — L2 multi-merge (`merged_into`, same 1.5.6, no extra version bump)

- **`src/l2Merge.js`** condenses duplicate same-tag L2 episodes into ONE durable
  record, offline at the end of `maintain()` (after monthly memos; a failure never
  fails maintenance).
- **Pinned and ordinary groups are strictly separated** — pinned merges only with
  pinned; ordinary only with ordinary. A pinned merge keeps `pinned: true` and
  inherits every tag.
- **Text**: earliest/latest time + deduplicated core text (each source capped), the
  whole line capped by `l2Merge.maxSummaryChars` (ASCII ellipsis so identity
  canonicalisation cannot make it longer).
- **Federated metadata**: `meta.global_tags` is copied into the merged record's
  `meta` and **never becomes a tag**, so it cannot enter the sub-space inverted index;
  `projectEpisode` exposes it as `event.globalTags` for the merge layer only.
- **Append-only marking**: sources are recorded as merged in
  `state/l2-merge.json` (`mergedSourceIds`); the log is untouched and originals stay
  recoverable. A second pass merges nothing (idempotent) and `status().panel.l2Merge`
  reports the bookkeeping.
- **Config `l2Merge`**: `enabled` (default true), `minGroupSize` (2–20, default 2),
  `maxGroupsPerRun` (1–50, default 5), `maxSummaryChars` (100–2000, default 400);
  fail-fast, HTTP-editable and rendered in the settings page.

### Added — L3 semantic tag invariant (same 1.5.6, no extra version bump)

- **`SemanticStore.upsert` is strict**: an L3 summary with zero usable tags is
  refused with **`MEM_E_SEMANTIC_TAG_REQUIRED`** — such a summary could never be
  reached by tag-driven retrieval (dead knowledge).
- **Offline paths degrade instead of failing**: delete-consolidation and trend
  promotion derive tags from content heuristics (`extractTags`) and, if even that
  yields nothing, write an explicit provenance anchor (`origin:unlabelled-episode` /
  `origin:unlabelled-trend`). Maintenance and the two-phase delete pipeline therefore
  never break on historical untagged events.
- **Historical data is read-only degraded**: summaries written before the invariant
  remain readable and are marked `degraded: true` in `list()` /
  `semanticSummaries()`; nothing is silently rewritten.

### Added — working mode survives a handoff (same 1.5.6, no extra version bump)

- **Handoff marker carries the Host agent preset** (the UI's “工作模式”): the marker
  written at rollover now records `agentPreset`, fed by the live adapter through
  `memory.setHandoffPresetProvider()`.
- **A new conversation restores it before its first turn**: `agent/created` is a
  serial Host event, so the bridge awaits `agentPresets.select(agent, preset)` for
  `source === 'startup'` from a different session. `resume`, the marker-owner session
  and markers without a preset are never overridden.
- **Never breaks agent creation**: a failed `select` is reported in
  `runtime.lastPresetInherit` and the log, then creation proceeds.
- **Tracking**: `agent-preset/selected` updates the mode; tool boundaries and prompt
  assembly opportunistically read `agents.currentInitiator()` + `agentPresets
  .composedPreset()` and **backfill an older marker** that predates this feature.
- **Observability**: `/stats` exposes `agentPreset` + `presetInherit`, and
  `hostStatus().presetSelections` counts observed selections.

### Changed — physical split: multi-space engine moved out (same 1.5.6)

- **`src/spaces/spaceRouter.js` and `src/spaces/transfer.js` are GONE from this
  package.** The full multi-space router (per-space FIFO chains, lazy child stores,
  `MEM_E_*` validation) and the cross-space transfer engine now live in
  `dsh-orchestrator` (`src/spaceRouter.js`, `src/transfer.js`).
- The core compiles only `src/spaces/singleSpace.js`: the `default` space is the
  owner handle; every named-space operation answers **`MEM_E_FEATURE_DISABLED`** with
  an explicit "install dsh-orchestrator" hint. No silent fallback to `default`.
- **Adapter injection is the wiring seam**: the Host's optional `orchestrator`
  service supplies `createSpaceAdapter({owner, dataDir, openChild})` and `transfer`;
  `Memory.open({spaces|spacesFactory, transfer})` accepts the same seam for embedders.
  Without the service the plugin advertises `capabilities.spaces=false`, registers
  only the eight single-space tools, and `/spaces` reports `default` only.
- A profile with `features.multiSpace:true` but no Orchestrator logs a loud warning
  and runs the strict single-space core (visible in `/stats.capabilities`), instead
  of pretending the capability exists.

### Added — first batch: orchestrator service + 3 experience fixes (same 1.5.6)

- **Orchestrator service registration**: `apply()` now installs a real Host service
  (`ctx.provide('orchestrator', …)` inside `ctx.effect`, so unloading removes it).
  It exposes `createSpaceAdapter`, `transfer`, `dirFor`, `status`, `federation`,
  `dedupe`, `consent` and `router`. The core decides the capability through
  `config.multiSpaceActive(config, hasOrchestrator)`.
- **Reserved system tags isolated from display**: `status:*`, `folded-summary` and
  `active_task` are filtered out of the knowledge graph (`buildGraph` + defensive
  `view`) and the L1.5 tag tree (`rebuildTree` + persisted-tree/ghost filtering).
  The inverted index still keeps them (handoff/recall internals need them).
- **`[Active Task]` injection**: prompt assembly prefers the active handoff summary,
  otherwise the newest event carrying a `task:` tag, and renders it as an
  unconditional top block (`[Active Task]`) once per session.
- **Fallback hints**: `selectRelevantTags` accepts `fallbackTags`; when the current
  input has no lexical overlap (e.g. “继续”), the previous turn's matched tags (max 2)
  are carried into `[Memory Hints]`.
- **Session-scoped injection dedup**: `runtime.injection` keeps per-session `ids` and
  `tags`; hints, `[Active Task]` and recall blocks already injected are filtered on
  later turns. SessionStart and rollover reset the pool, so the next session receives
  the handoff content again.
- **Space deletion (UI + engine)**: `SpaceRouter.deleteSpace(id, {confirm})` closes
  the child handle, evicts its queues/caches and removes the directory (refusing
  `default` and requiring `confirm:true`). `Memory.deleteSpace` / `runtime.deleteSpace`
  gate the same rules (named space only; `MEM_E_FEATURE_DISABLED` in the strict
  single-space core). The HTTP route reuses `POST /spaces` with
  `{action:'delete', space_id, confirm:true}`; an **unknown action is a 400** and
  never falls through to CREATE. The SpaceSelector renders `🗑 删除空间` only for a
  named space AND only when the new **`capabilities.spacesDelete`** handshake is
  true — an old/pre-delete host therefore hides the button instead of answering the
  misleading “空间已存在”. When `capabilities.spaces` is false the entire space UI
  (selector, create/delete, current-space chip) disappears silently.

### Added — local low-valley Dream scheduling (same 1.5.6)

- **No external price plugin required**: `src/priceWindow.js` computes Beijing-time
  peak/valley locally (weekday 09–12 / 14–18 peak; lunch, nights and weekends low).
  Chinese holidays are NOT modelled (the calendar moves yearly); `DSH_DREAM_PRICE=low|high`
  or a Host price probe still override it.
- **The Host bridge gets a default probe** from `isLowValley()`, so a compensating
  Dream skips peaks (`reason:'peak'`) and runs locally in the valley.
- **Idle LLM Dream defers instead of spending at peak**: `runtime.tick()` writes a
  durable `state/dream-queue.json` (`pending, dueAt, reason:'peak-hour'`), emits
  `dream-deferred`, and runs the queued Dream as soon as the valley opens — the queue
  survives a restart, so a missed window is not lost.
- **Config `dream.onlyLowValley`** (default true; fail-fast, HTTP-editable, settings
  toggle). A local-only Dream (no LLM) is never gated by price.
- `/stats` exposes `dreamWindow` (low/reason/nextLowAt), `dreamQueue` and `dreamTimer`.
- **Phase 2 — wake timer + sleep correction**: `src/dreamTimer.js` arms ONE wake-up
  at the queued due time / next valley (injectable timers, `unref`ed). On fire it
  re-reads the CLOCK and the WINDOW: a late wake after an OS sleep is reported
  (`lateMs`, `catchUp`) and runs; a wake that lands in a peak re-arms for the next
  valley instead of spending. Boot arms from the persisted queue, so a queue left by
  a previous run catches up with delay 0. Disposal cancels the timer.
  `dreamTimer` status (arms/wakes/lateWakes/reschedules/runs) is exposed on `/stats`.

### Added — Federation / cross-space dedupe wiring (same 1.5.6)

- **Federation on write**: after a successful write the engine reports the record's
  BUSINESS tags (never `status:*` / `month:*` / `active_task`) to the Orchestrator's
  global `FederationMap` with the space id; a tag seen in two spaces becomes ONE
  global node listing both. A missing/broken service can never fail the write.
- **Dedupe on monthly memos**: `generateMonthlyMemos()` claims `sha256(content)` in
  the Orchestrator's `ContentRegistry` as `monthly:<spaceId>`; a sibling space with
  the identical monthly workload skips its copy and reports
  `monthly.skipped`/`skippedEntries` (owner traceable). Same-space reruns are
  idempotent.
- Services arrive through the existing `orchestrator` adapter extras; spaces carry
  their own `spaceId` (`path.basename(childDir)`), the default space is `default`.
- **Read-time merge on recall**: monthly memos now persist `meta.source_event_ids`,
  and `projectEpisode` exposes `sourceEventIds`. `Memory.mergeRecallHits()` feeds the
  recalled hits through `ContentRegistry.mergeForRead()`: a memo wins over the events
  it owns, duplicate `contentHash` collapses monthly-first, and the payload reports
  `merge: {space,monthly,droppedOwnedByMonthly,droppedDuplicateContent,total}`. Only
  when the Orchestrator dedupe service is present; the pure core payload shape is
  unchanged.
- **Cross-space recall aggregation**: `Memory.recallAcrossSpaces()` queries every open
  space under its own lock, tags each hit with `spaceId`, and folds the union through
  the same `mergeForRead()` (raw hits are requested with `mergeRecall:false` so the
  aggregation sees owned events before the memo hides them). It is **opt-in**:
  `features.crossSpaceRecall` defaults to **false**, is fail-fast (true without
  multiSpace is a contradiction), HTTP-editable and rendered in the settings page.
  Only when `crossSpaceRecall:true` does `runtime.recall()` use this path; otherwise
  the single-space payload is unchanged (`mode` is never `cross-space`).
  `mode:'cross-space'`, `spaces`, `merge` and per-hit `spaceId` are reported.

### Tests

- New `test/v156.rawscan.test.js` (5 cases): newest-first + absolute line number
  (5000-line shard), turn-budget truncation without reading the head, engine result
  ceiling, `readLinesReverse` peak buffer ≤ chunk + one line over a 20k-line file,
  and `restoreByHash` over the streaming path.
- New `test/v156.hardening.test.js` (5 cases): recall payload truncation and
  under-budget pass-through, `maxInjectTokens` fail-fast, `close()` resource release
  and idempotency, lag monitor yield after a 120ms block, maintenance `eventLoop`.
- New `test/v156.tagging.test.js` (7 cases): extraction matrix, untagged write gets
  an anchor and becomes recallable, raw purity (four fields), manual tags win +
  dedupe, miss warning + panel counter, `autoTag:false`, config fail-fast.
- New `test/v156.pinned.test.js` (3 cases): pinned without tags refused and no
  write, one-year decay still `decay=1` + index/tag flags + pinned-first ranking,
  pinned tag stays in the active set after a 400-day maintenance.
- New `test/v156.hints.test.js` (4 cases): selector matrix (match/unrelated/internal/
  empty), hint rendering, prompt tail contains only matching tags after the block
  marker with a stable prefix, `session/event` user turn tracking.
- New `test/v156.features.test.js` (5 cases): flag fail-fast + implied transfer-off,
  strict single-space engine + capabilities/tools absent, transfer-only-off,
  defaults unchanged, `Memory.open(string)` + lazy `warmup()`.
- New `test/v156.host.test.js` (6 cases): price normalisation; session start runs one
  compensating Dream; unknown price + LLM skipped; peak skipped; not-due / disabled /
  in-flight refused; MockHostEnvironment integration through `apply()` + `hostStatus`
  surfaced on `/stats`; `dream.compensateAfterHours` fail-fast.
- New `test/v156.dreamui.test.js` (3 cases): safe Dream subset exposed / credentials
  absent from the payload; tunables editable over HTTP while `dream.llm.*` is not;
  settings page renders the section and offers no credential field.
- New `test/v156.l2merge.test.js` (4 cases): pinned/ordinary strict separation with
  global-tag metadata preserved as meta (never a tag); a lone ordinary record is not
  dragged into the pinned group; `maxSummaryChars` cap + `enabled:false`; config
  fail-fast. Older fixtures disable `l2Merge` so their exact index-count assertions
  stay deterministic.
- New `test/v156.l3tag.test.js` (4 cases): strict upsert refusal; delete-consolidation
  derives `error:typeerror` / `origin:unlabelled-episode` instead of dead knowledge;
  trend promotion derives tags before writing L3; historical untagged summaries are
  readable but `degraded`.
- New `test/v156.preset.test.js` (6 cases): marker records the working mode; a new
  conversation restores it through `agentPresets.select`; older markers are
  backfilled from the live agent; resume / same-session / marker-without-preset never
  override; a failed select does not fail creation; `agent-preset/selected` keeps the
  tracked mode current.
- New `test/v156.singleSpace.test.js` (3 cases): the core works for `default` and
  refuses named read/write/create/ensure/transfer; without the Orchestrator the plugin
  advertises `spaces:false`, registers eight tools and never advertises a dead tool in
  the prompt; injecting the adapter restores ten tools and `spaces:true`.
- Updated: manifest 1.5.5 → 1.5.6; settings page gains `context.maxInjectTokens`,
  the pre-ingest tagging section, Dream tunables and the L2-merge section; editable
  contract gains `tagging`, `features`, `dream` and `l2Merge`; panel contract gains
  `global.pinned`, `autoTag` and `l2Merge`; `plugin.test` prompt contract now asserts
  relevance hints instead of the removed global map.
- New `test/v156.firstBatch.test.js` (5 cases): reserved status tags never reach the
  graph/tag tree; `[Active Task]` from the handoff summary and from a `task:` event;
  fallback hints reuse the previous turn's tags; session dedup blocks the second
  injection and resets on a new session.
- New `test/v156.spaceDelete.test.js` (5 cases): engine deletion with confirm/default/
  missing rules; strict single-space refusal; **`capabilities.spacesDelete` versioned
  handshake** (an old host hides the button, so a delete request can never be
  misread as CREATE); `POST /spaces {action:'delete'}` removes the store and returns
  the refreshed list; unknown actions answer 400 instead of falling through to
  CREATE; the UI source carries the capability guard, the button, the human confirm
  and the default-space guard.
- **Graph interaction layer** (`test/v156.graph.test.js`, 4 cases): Ctrl/Cmd+drag
  pans the canvas (plain drag still moves a node), Ctrl/Cmd+wheel zooms around the
  cursor via a non-passive native listener (plain wheel keeps page scroll),
  double-click on blank space resets the view, and the frozen initial layout runs
  through `separateOverlaps()` so nodes never start piled on top of each other.
  The header/footer advertise the interaction.
- New `test/v156.lowValley.test.js` (4 cases): Beijing peak/valley boundaries and
  next-low computation; `dream.onlyLowValley` fail-fast + editable; a peak-hour idle
  Dream is deferred durably and runs at the valley; the Host bridge probe follows the
  window while `DSH_DREAM_PRICE` remains an override.
- New `test/v156.federation.test.js` (2 cases): business tags federate into one
  global node across spaces while internal tags are skipped; the first space claims a
  cross-space monthly memo and the sibling reports `skipped` with the owner.
- New `test/v156.lowValley2.test.js` (4 cases): peak wake re-arms (never runs); a
  sleep-delayed wake reports `lateMs`/`catchUp`; a past-due queue in the valley arms
  delay 0; runtime integration: peak deferral -> timer fire -> queue cleared and
  `dreamTimer.runs === 1`.
- New `test/v156.readMerge.test.js` (2 cases): a recalled monthly memo drops the
  events it owns and reports merge stats; without the dedupe service the recall
  payload is unchanged.
- New `test/v156.crossSpaceRecall.test.js` (2 cases): a recall returns hits from every
  open space with provenance; a monthly memo hides its owned event even when recorder
  in another space, while the other space still contributes.
- New `test/v156.crossSpaceRecallFlag.test.js` (3 cases): default false + fail-fast
  (`true` without multiSpace is a contradiction, non-boolean rejected); flag true
  aggregates open spaces; flag false keeps the single-space payload.
- **Settings-page GitHub installer**: new `POST /api/hippocampus/orchestrator/install`
  (requires `{confirm:true}`) delegates to the Host's
  `pluginManager.installBundle('git+https://github.com/382quaii/dsh-Layers-Orchestrator.git', {enabled:true})`,
  short-circuits when the service is already present, and reports
  `applied | restart-required | manual | failed`. The settings page ships a
  “从 GitHub 安装 dsh-orchestrator” button (human confirm dialog) plus the repo link;
  without `pluginManager` it shows the exact manual steps instead of failing silently.
- **Automatic new conversation on handoff (verified feasible)**: the Host exposes
  `agents.create/resume` and, decisively, the CLIENT service
  `uiWorkspace.startSession()` — the same action the “+” button uses. A client-half
  controller polls `/stats`, and when `handoff.active && handoff.autoNewSession` it
  calls `uiWorkspace.startSession(undefined, {agentPreset})` once per handoff marker
  (sessionStorage guard, lifecycle-owned interval, capability-guarded no-op on old
  hosts). New config `context.autoNewSession` (default **true**, fail-fast,
  HTTP-editable, settings toggle), plus `context.autoNewSessionPoll`
  (`interval` | `once`, default `interval`) and
  `context.autoNewSessionIntervalSeconds` (5–3600, default 15): the settings page
  now exposes a “按间隔轮询 / 只检查一次” select and an interval slider; the client
  configures its timer from the FIRST stats response (`once` clears the recurring
  timer). The workspace-file handoff scheme is no longer needed and stays documented
  only as a fallback.
- **Fixed — new-conversation failure `tool "subagent" is already registered`**:
  handoff preset inheritance no longer calls `agentPresets.select()` when the new
  session is ALREADY composed with the marker's preset. A redundant recompose
  re-mounted the preset's `@deepseek-ai/dsh-tool-subagent` row and aborted session
  creation; the skip is recorded as `presetInherit.reason='already-composed'` and
  locked by a regression test in `test/v156.preset.test.js`.
- **Persona section + generic custom decay (v1.5.7)**:
  - `[Persona & Traits]` is its own prompt section (`name:'persona'`, **order 100**),
    rendering the ≤10 highest-confidence L3 semantic summaries (live store read, not
    the recall cache). The memory block/policy/reflection sections keep 2450/2455/2460.
  - `service.remember()` accepts **`customDecayRate`** (finite, 0 < rate ≤ 10) OR
    **`customHalfLifeDays`** (integer 1–36500), never both. The value is normalised to
    `meta.decay_rate`, projected as `decayRate`, and applied as
    `effectiveHalfLife = policyHalfLife / decayRate` for THAT record only. No
    tag-prefix logic exists anywhere in the engine — an emotion plugin decides the
    semantics by passing the parameter.
- **Cross-plugin `ctx.provide('hippocampus', service)`** (user decision 2026-11-05:
  in-process service only, NO HTTP write surface): `apiVersion=1`, `ready()`,
  `capabilities()` (declares `l3Traits:10` plus per-method support), `remember()`
  (L2-only; non-L2 layers are redirected with a warning; returns
  `{status,eventId,eventTime,duplicate}`), `recall()`, `runMaintenance(source)`
  (never queues: a running pass answers `MEM_E_MAINTENANCE_RUNNING`; manual passes
  are rate-limited to 30 s while `cron` bypasses), `stats()/handoffView()/
  promptState()` read-only snapshots and `onDispose()` hooks. The service disappears
  with its plugin fiber; later calls answer `MEM_E_SERVICE_DISPOSED`. New codes
  `MEM_E_MAINTENANCE_RUNNING`, `MEM_E_SERVICE_DISPOSED`, `MEM_E_FEDERATION_FAILED`
  are registered append-only (8 cases in `test/v157.service.test.js`).
- **Durable Orchestrator state**: `<root>/state/orchestrator.json` now persists the
  global federation map and the monthly-memo claims (atomic tmp+rename on every
  mutation); it is loaded before the services become observable, and a corrupt file
  is treated as empty instead of failing activation — a restart no longer forgets
  cross-space dedupe.
- Full suite: **411 tests / 411 pass / 0 fail**, 64 test files. Orchestrator:
  **31/31** (`service` + `spaces` deletion + `persistence` round-trip/corrupt state).
  **Installed locally**: desktop profile gets a `link:` dependency + an ordered patch
  insert BEFORE the hippocampus entries, so the service exists at activation. Two
  Cordis constraints were fixed on the way: `apply()` must return **undefined**
  (the return value is treated as an effect → `TypeError: Invalid effect`), and the
  service is registered directly with `ctx.provide` (itself an effect). The market
  catalog still does **not** list it: that needs an npm publish / catalog submission.
- Added `docs/RELEASE-1.5.6.md`: release notes + the exact push/tag/npm/market
  commands that require the operator's credentials (none executed here).

## [1.5.5] — 2026-11-03

**Offline Dream distillation: an optional LLM pass that can never take Dream down.**
Same-tag L2 records are distilled into one durable, provenance-carrying record.
The LLM leg uses **Node's built-in `fetch` only** (charter v2.0 #1: still zero
dependencies); endpoint / model / key are injected through config or
`DSH_DREAM_LLM_*` env and are never hard-coded, logged, or returned by HTTP.
Every failure — no config, network down, timeout, non-JSON — silently degrades to
the deterministic local merge and records `MEM_E_DREAM_LLM_FALLBACK`. **303 tests
green** (was 295).

### Added — Dream LLM distillation (`src/dream.js`, `Memory.executeDream`)

- **Structured output**: the model must answer JSON `{"summary","confidence"}`;
  `summary` is capped at `dream.maxSummaryChars` (default 200). Fenced code,
  non-JSON, missing fields and over-long summaries are all treated as LLM failure.
- **Zero-dependency transport**: Node's global `fetch` against an
  OpenAI-compatible `/chat/completions`; `Authorization: Bearer` only when a key is
  configured. No SDK, no `node-fetch`, no new `package.json` dependency (test-locked).
- **Absolute timeout**: `AbortController` + `Promise.race` under
  `dream.llmTimeoutMs` (default 15s); the timer is always cleared in `finally`.
- **Local fallback**: earliest/latest time + deduplicated core text, capped to
  `maxSummaryChars`. Degradation warns `MEM_E_DREAM_LLM_FALLBACK` and is visible in
  `status().panel.dream.lastFallback`.
- **Provenance**: the distilled record always carries
  `meta.source_event_ids` (deduped, sorted) and `meta.distilled_by` (`llm|local`);
  a re-run never merges the same source twice (`state/dream.json` bookkeeping).
- **Circuit breaker**: `failureThreshold` (default 3) consecutive failures open the
  breaker for `cooldownMinutes` (default 60); afterwards a half-open state allows
  exactly one probe — success closes it, failure re-opens. Exposed as
  `panel.dream.circuit`.
- **Single-flight + serial**: a concurrent `executeDream()` is refused
  (`dream-in-flight`); within one run groups are processed strictly serially, so a
  slow provider can never exhaust connections or accumulate queued work.
- **Offline only**: `executeDream()` is called exclusively from the `dream` branch
  of the maintenance gate, after `maintain()` converged; the online
  `recall`/`remember` paths never touch the network.

### Config

- New `dream` group (fail-fast validated): `useLlm`, `minGroupSize` (2–50),
  `maxGroupsPerRun` (1–50), `maxSummaryChars` (40–2000), `maxSourceChars`
  (80–4000), `maxEventsPerGroup` (2–50), `llmTimeoutMs` (500–120000),
  `failureThreshold` (1–20), `cooldownMinutes` (1–1440), and
  `llm.{baseUrl,model,apiKey}`. The `llm` block is deliberately **not** part of the
  UI/HTTP config projection, so a credential can never leak through the panel.

### Tests

- New `test/v155.dream.test.js` (8 cases): no-config local fallback with full
  provenance; LLM success (URL/header/body/JSON parse); non-JSON degradation;
  fetch timeout degradation; single-flight refusal; circuit open → no fetch →
  half-open single probe → close; `dream` config fail-fast matrix; `package.json`
  dependency red line.
- Updated: status-panel contract gains `dream`; manifest 1.5.4 → 1.5.5.
- Full suite: **303 tests / 303 pass / 0 fail**, 41 test files.

## [1.5.4] — 2026-11-02

**Hotfix: the automatic handoff state machine can no longer wedge a session, and
recursive handoff summaries are cut off at the source.** Incident: recursive
`交接摘要` generations inflated the ratio past the native window and a handoff that
failed could leave the machine stuck, blocking new sessions. **295 tests green**
(was 286).

### Fixed — state machine (no deadlock, Fail-Fast with graceful degradation)

- **`checkHandoff()` never rejects**: a distillation error, a timeout (default 5s,
  injectable per call) or a marker-write failure degrade to a `state:"failed"`
  marker carrying `summaryError` and return immediately. The next session starts
  regardless.
- **New-session transition resets everything**: `observeSessionTokens()` always
  establishes the new session's own baseline, consumes a marker belonging to a
  different session, and **releases `_handoffInFlight`**, so a hung handoff guard
  can never own the next session. A same-key restart (estimate halved after reset)
  is treated as a new baseline too.
- **Stale marker consumption happens before early returns**, so a fresh session
  cannot inherit "handoff active" forever.
- **Outer watchdog in `_maybeAutoHandoff()`** in addition to the inner one: even if
  `checkHandoff` itself hangs, the in-flight flag is released in `finally`.

### Fixed — recursion

- **`_distillHandoffTail()` refuses handoff content** by tag (`status:handoff`) and
  by the `交接摘要` text prefix, in both the live-context path and the indexed
  fallback. Output is hard-capped at 1200 characters; the idempotency key includes
  the timestamp so distinct epochs never collide. (No more summary-of-summary.)
- **`status:handoff` is internal**: 2% weight in normal recall and excluded from the
  recent-memory list, so real facts always outrank handoff bookkeeping.

### Added — escape hatches and cleanup

- **`Memory.resetSessionState()` / `memory_admin action=reset_session` /
  `POST /api/hippocampus/session/reset` / settings-page 「强制重置交接状态（逃生舱）」**:
  clears the live token baseline, the in-flight guard and the active marker. It
  rewrites only `state/`; durable memories are untouched.
- **`Memory.repairHandoffSummaries()` + `scripts/repair-handoff.mjs`
  (`npm run repair-handoff`)**: finds recursive/excess handoff generations
  (recursive = >=2 `交接摘要` markers) and parks them in the two-phase
  `pending_delete` queue. Dry-run by default; `--reset-marker` consumes a stuck
  marker.
- Panel session status now exposes `handoffState` / `handoffDegraded` /
  `handoffErrorCode`; a degraded handoff is visible in the status bar instead of
  silently locking.
- New error code **`MEM_E_HANDOFF_FAILED`**.

### Tests

- New `test/v156.handoff.test.js` (9 tests): recursion refused by tag/prefix and
  fallback path; throwing/hanging distillation degrades without rejecting; new
  session resets ratio and releases the stuck guard; handoff summary ranking and
  list isolation; `resetSessionState` preserves memories; repair dry-run + pending
  delete; admin tool + HTTP escape hatch (route table 8).
- Route contract 7 → 8, manifest 1.5.4.
- Full suite: **295 tests / 295 pass / 0 fail**, 40 test files.

## [1.5.3] — 2026-11-02

**Hotfix: space creation no longer exposes a raw `MEM_E_SPACES: HTTP 404`, and
invalid/conflicting space names are rejected by the ENGINE with
`MEM_E_SPACE_INVALID`.** Incident: a new client bundle called
`/api/hippocampus/spaces` against a host process that predated the route (the same
process also 404s `/memories`). Fixed on three layers plus a route-drift test.
**286 tests green** (was 270).

### Added — release hygiene

- **Benchmark Protocol v1 (`scripts/bench-protocol.mjs`, `npm run bench`)**: the only
  sanctioned way to publish a throughput number. Each measured run gets a fresh
  `os.tmpdir()` store, one discarded same-process warmup precedes 5 measured runs,
  and the report carries MEDIAN + min/max/spread. It makes no speed assertions
  (a shared/AV-scanned machine must report, not fail), so single-run noise cannot
  become an architecture conclusion again. Replaces the deleted single-run
  `scripts/confidence-ab.mjs`.
- **Multi-space fixed-overhead coverage (`test/v154.release.test.js`)**: N=10
  physical spaces — bounded per-space boot (<500ms median), lazy root boot
  (`spaces.open=[]`, children never eagerly opened), uniform per-space storage
  (max/min ≤1.35), linear total bytes (≤1.3×N), per-space fixed overhead <256KB.
- **Dead config removal**: `context.minInjectConfidence` is gone end-to-end
  (default/validation/projection, HTTP-editable key,
  `applyConfidence`/`MIN_INJECT_CONFIDENCE` retrieval pass, recall
  `confidence`/`lowConfidence` annotations and low-confidence notes, obsolete A/B
  script). Supplying the old key fails fast with `MEM_E_CONFIG_UNKNOWN_KEY`
  (`details.removedIn = "1.5.3"`), so a profile cannot keep believing it works.
- Test watchdog default 30s → 60s (the in-process suite boots real stores/spaces and
  legitimately takes ~15–25s; the watchdog now only fires on real hangs).

### Added — tool schema pruning

- **`tools.disabled` config (default `[]`)**: every registered tool definition costs its
  JSON schema in prompt tokens on EVERY turn (~1.1–1.2k tokens of baseline tax). A
  closed suffix vocabulary (`remember/checkpoint/recall/capture/bulk_ingest/reinforce/forget/space_transfer/transfer_to_global/admin`)
  lets an operator prune low-frequency tools; `remember`/`recall`/`admin` are CORE
  and cannot be disabled. A typo/prefix/full name, a core tool, or a duplicate aborts
  config resolution with **`MEM_E_INVALID_TOOL_NAME`** (fail-fast, never silently
  ignored). The register wrapper skips disabled suffixes AND the `memory` prompt
  section stops advertising them, so the schema prune cannot lie to the model.
  Editable over HTTP (`tools.disabled`) and rendered in the settings page as a
  checkbox catalog with core-不可关闭 / low-frequency tooltips. Takes effect on the
  next host start/reload (tool registration happens at activation).

### Fixed

- **Route-drift lock**: a new test parses the client `API` constant table and
  proves every path equals the backend `MEMORY_API` value verbatim, and that the
  registered route table contains them all. Adding a route on one side without the
  other now fails CI instead of 404-ing in production.
- **Capability handshake**: `/stats` (ready AND booting) and `GET /spaces` now carry
  `capabilities: { version, spaces, memories, transferConsent, multiSpace }`.
  The client checks `capabilities.spaces` BEFORE calling `POST /spaces`; if the
  host is older it shows a version hint and disables the action instead of firing a
  request that 404s. `memories` is gated the same way (old host → "当前宿主版本不
  支持记忆列表", not `MEM_E_MEMORIES`).
- **Human error copy**: every space-create failure now renders a complete sentence.
  404 / route-missing / network → `创建失败：底层引擎未响应，请检查版本或联系架构师`;
  invalid name → `创建失败：空间名称无效——需以小写字母/数字开头，只能含 a-z 0-9 . _ -（最长 64）`;
  duplicate → `创建失败：空间「33」已存在，请换一个名称`; reserved → `创建失败：该名称是
  系统保留名，请换一个`. The `MEM_E_SPACES: HTTP 404` template is gone from the bundle.
- **`MEM_E_SPACE_INVALID` (400)**: `validateNewSpaceId` + `Memory.createSpace` reject,
  before any directory/JSONL write: empty/whitespace, wrong charset (`Bad`, `bad id!`,
  path separators, `..`, `.`), >64 chars, trailing dot (Windows alias), Windows
  device names (`con`, `nul`, `com1`, …), `default` (always exists), an existing
  space (conflict), and a non-directory path collision. Creation returns `201`,
  conflicts/invalid ids `400 MEM_E_SPACE_INVALID`.
- Fresh spaces are created from `POST /spaces` with a strict non-idempotent
  `runtime.createSpace`; the lazy `ensureSpace` used by transfer keeps its
  idempotent semantics.

### Tests

- New `test/v153.spaces.test.js` (7 tests): client↔backend route-path equality
  (the anti-404 lock), a real dispatch through the CLIENT path against the
  registered host route table (handler answers 201, never a router 404),
  invalid/reserved matrix, engine conflict-before-write, HTTP 201/400 + capability
  handshake, human-copy mapper (no raw 404), capability gating for old hosts.
- Updated: `POST /spaces` assertions 200 → 201 strict creation; manifest 1.5.3.
- Full suite: **286 tests / 286 pass / 0 fail**, 39 test files (includes
  `v154.release.test.js`).
- **Note (deployment)**: the live host process observed during the incident still
  404s `/spaces` and `/memories` — it must be restarted/reloaded for the new routes
  to serve; until then the new client degrades with the version hint above instead
  of a naked 404.

## [1.5.2] — 2026-11-02

**Architecture correction: physical storage migration vs. business-data transfer
are now physically decoupled, and the UI has a real global SpaceSelector.** The
v1.5.0/v1.5.1 UI mixed two unrelated concerns and let the user type
`target_space_id`/`event_ids` by hand. Fixed and locked by tests. **270 tests
green** (was 263).

### Changed — UI (module decoupling)

- **Physical dataDir migration extracted** into `StorageMigratorUI`, a SYSTEM/DATA
  MANAGEMENT section at the bottom of the settings page. It owns only the A/B
  double-buffer state machine: `POST { dataDir }` → `202 state=migrating` → copy →
  verify → swap, old directory kept as a backup. No event ids, no spaces.
- **Business cross-space transfer removed from the settings form**: the manual
  `event_ids` / `target_space_id` text inputs, the copy/cut buttons and the
  inline confirmation are gone. Business transfer now exists ONLY in the panel's
  regulated flow (below).
- **Global `SpaceSelector`** in the panel header: a dropdown of the physical spaces
  (friendly labels: 默认空间 / 工作空间 / 私人空间 / 全局空间, unknown ids verbatim)
  with `＋ 新建空间` (creates an EMPTY space — never a copy). The selection is
  app-global (`spaceStore` + `space-changed` bus event), so the panel and the
  settings page follow it.
- **Every UI read follows the selected space**: `useMemoryStats`, `useGraph` and
  `useRecentMemories` append `?space=<id>`; the backend routes `stats`, `graph` and
  `memories` to that physical store. Memory list, graph, L1 log/index counts, L2.5
  quarantine, L3 semantic count, L1.5 tag tree and the session status bar are all
  that space's only — switching spaces cannot blend views or contexts.
- **Regulated cross-space flow (UI_TASK_3)**: check memories in the current space →
  `移动到…` → dialog step 1 states `即将向 [目标空间] 发起迁移请求` → step 2 is the
  SECOND explicit consent (`二次确认 · 安全红线`, with the cut warning when 剪切) →
  only then is `user_approved: true` sent. Target is a dropdown of known spaces,
  never a free-text id.
- `h(StorageMigratorUI)` is a separate component, so the two state machines can no
  longer share draft state or validation.

### Added — backend routing

- **`GET/POST /api/hippocampus/spaces`**: list the router's spaces / create an empty
  one (`space_id`). The selector and `＋ 新建空间` use it.
- **`?space=<id>` on `/api/hippocampus/stats` and `/api/hippocampus/graph`**:
  `runtime.uiPayload(spaceId)` / `runtime.graphPayload(spaceId)` return that space's
  panel/graph via `Memory.status({ targetSpaceId })` and
  `Memory.graphForSpace({ targetSpaceId })`; a new space reports zeros (empty), so a
  switched view is never a fallback to the default store.
- `Memory.ensureSpace()` (root router) and `runtime.spaceList()`.
- Panel status `panel.spaces.current` now reports the SELECTED space (was always
  `default`), and `stats`/`graph` responses carry a top-level `spaceId`.

### Security (unchanged red line, stricter transport)

- The HTTP transfer route no longer fabricates consent: it forwards
  `user_approved` from the request and the ENGINE gate rejects a request that lacks
  it with `MEM_E_REQUIRE_USER_CONSENT`. The UI only sets the flag after step 2. An
  agent tool call and a raw POST that "bypasses the UI" therefore hit the same
  wall.
- `dataDir` migration Fail-Fast strengthened: `validateMigrationPaths` now also
  rejects an existing non-empty target (`MEM_E_MIGRATION_TARGET_BUSY`) and a
  non-directory target (`MEM_E_MIGRATION_PATH`) synchronously, before a 202/job.
  The old store remains authoritative on any rejection.

### Tests

- New `test/v152.refactor.test.js` (7 tests): dataDir validation matrix
  (missing/relative/same/inside/root/non-empty/non-dir) + `startMigration`
  fail-fast with the old dir intact; space isolation for stats/graph/memories/
  session/recall with `?space=`; `ensureSpace` empty space + spaces route;
  unauthorized transfer blocked at engine AND HTTP, authorized passes; UI wiring
  (SpaceSelector header mount, checkbox flow, no manual inputs, isolated
  StorageMigratorUI).
- Updated contract assertions: HTTP routes 6 → 7 (spaces), transfer route requires
  explicit `user_approved`, settings order now context → space/session → system
  storage, cut second-confirmation now lives in the panel dialog, manifest 1.5.2.
- Full suite: **270 tests, 270 pass, 0 fail**.

## [1.5.1] — 2026-11-02

**Security patch: cross-space transfer now requires EXPLICIT user consent.** Moving
memories between spaces is a data-egress action, not a memory optimisation. Two
independent locks (prompt + engine), plus a human-only UI path. **263 tests green**
(was 254).

### Added

- **Prompt red line (`memory:policy`)**: a static `【🚨最高安全红线】` block forbids
  the model from calling `memory_space_transfer` / `memory_transfer_to_global` on
  its own judgement, sympathy, or "better cross-device sharing". The only allowed
  trigger is a direct user command in the current conversation; when unsure the
  model must ask `您需要我把这条信息同步到其他空间吗？`. It also documents the
  `user_approved: true` retry protocol for `MEM_E_REQUIRE_USER_CONSENT` and states
  that the intercept is never a one-off obstacle to bypass.
- **`memory_transfer_to_global` tool**: copy/move memories from a space into the
  canonical `global` space, with the same privacy screen, raw_turn stripping, fresh
  target ids and consent gate as `memory_space_transfer`. Both tool schemas expose
  `user_approved` and their descriptions carry the security warning.
- **`context.requireExplicitConsentForTransfer`** (default **true**, validated
  boolean, HTTP-editable and exposed in the settings page): the operator's master
  switch for the engine gate. The settings toggle explains the risk.
- **`GET /api/hippocampus/memories`** (`limit`, `space`): bounded recent-memory
  projection (`eventId`, `day`, `tags`, `snippet`) used by the panel's per-memory
  detail rows. `Memory.recentMemories()` is read-only and index-snapshot based.
- **UI per-memory 分享/转移 button**: the panel now lists the 20 most recent
  memories with a human-initiated transfer dialog (target space, copy/cut toggle,
  second confirmation for cut). It calls the transfer route directly — **bypassing
  the model entirely** — and the browser request is the consenting human.

### Fixed / Security

- `Memory.transferEvents()` now throws
  **`MEM_E_REQUIRE_USER_CONSENT`** with the fixed message
  `[系统拦截] 跨空间传递需要用户明确授权。请向用户确认后再试。` when
  `context.requireExplicitConsentForTransfer` is true and the call does not carry
  `userApproved === true`. The gate runs **before** space ids are validated, before
  any store is opened, before content is read and before any pending-delete record
  is written, so a refused call is provably side-effect free.
- `POST /api/hippocampus/transfer` is documented and implemented as the **human
  channel**: it marks `userApproved: true` itself (same-origin authenticated
  browser request). The agent half cannot reach HTTP routes, so a UI click needs no
  model involvement and a model call still hits the gate.
- The consent gate is strict: `userApproved` must be the boolean `true`; the
  config value must be a boolean (a string like `"yes"` fails fast).

### Tests

- New `test/v151.consent.test.js` (9 tests): default-on config + fail-fast type
  check; engine gate fires before validation/IO (invalid target still answers
  CONSENT, nothing parked, source untouched); agent tool blocked then succeeds only
  with `user_approved: true`; `memory_transfer_to_global` same contract; explicit
  config opt-out; engine-level facade contract; prompt red-line markers; HTTP route
  marks consent; UI 分享/转移 + direct-API contract.
- Intentional contract growth updates: tools 9 → 10, HTTP routes 5 → 6, v150 UI
  route/transfer assertions extended with `userApproved`, manifest 1.5.1.
- Full suite: **263 tests, 263 pass, 0 fail**.

## [1.5.0] — 2026-11-02

Tag-explosion defence, physical multi-space routing, session handoff and the
cross-space transfer API. The plugin stays deliberately permission-free: the
complex permission choreography belongs to the future Orchestrator plugin, while
this engine owns only physical memory. **253 tests green** (was 200).

### Added — module 1: tag-explosion defence (P0)

- **`index.maxPostingsPerTag` (default 500, 1–100000)**: derives the inverted index
  with a hard physical cap per tag. When a tag exceeds it, the retained pointers are
  chosen by `salience desc -> eventTime desc -> eventId asc` and re-sorted for
  retrieval (`eventTime desc`, then id). `eventCount`, `mass` and `lastSeen` are
  still aggregated over **all** events, so the counts the degradation layer reports
  are honest; only the in-memory posting pointers are dropped (the JSONL log is
  untouched and rebuildable). Tags expose `postingsLimit` / `postingsTruncated` /
  `postingsDropped`; index stats expose `postingsTruncated` / `postingsDropped`.
- **Recall degradation for oversized tags**: an EXPLICIT query tag holding more than
  50 memories (`TAG_OVERFLOW_THRESHOLD`) is not expanded into the candidate pool.
  The response carries `oversizedTagHints: [{ tag, total, code:
  'MEM_E_TAG_OVERFLOW', hint: '[系统提示] 发现关于 [tag] 的记忆共 N 条，数据量过大。
  请提供更精确的 startTime/endTime 或使用 deep_raw 查阅。', window }]` and the
  course-block fallback is suppressed so the flood cannot re-enter through the back
  door. If the caller insists (a second recall on the same tag), only the **3 most
  recent** summaries are returned (`oversizedRecent: true`,
  `oversized-tag-recent:3`). Graph neighbours of an oversized tag are never woken.
- **`deep_raw` super-tag gate**: a query touching a tag with more than 500
  associations (`SUPER_TAG_THRESHOLD`) without `start_time`/`end_time` now throws
  **`MEM_E_TIME_RANGE_REQUIRED`** (narrow queries keep the old
  `MEM_E_INVALID_INPUT` contract). One authority decides: the tool no longer
  pre-validates the window.

### Added — module 2: multi-space routing & session handoff (physical layer)

- **Config** `context.autoSpaceFollow` (false), `context.autoRolloverEnabled`
  (true), `context.autoRolloverThreshold` (0.85, 0.5–0.99),
  `context.nativeTokenLimit` (8000, 512–1000000) — validated fail-fast, editable
  over HTTP and in the UI.
- **`SpaceRouter`** (`src/spaces/spaceRouter.js`): `targetSpaceId` on
  `remember`/`recall` routes to an isolated physical store
  (`<dataDir>/spaces/<id>`, `default` = the existing store, so every old path is
  byte-identical). One FIFO promise chain **per space**: same-space operations are
  serialised, different spaces run concurrently (a single global lock would
  reintroduce the cross-space stalls spaces exist to remove). Ids become directory
  names, so `^[a-z0-9][a-z0-9._-]{0,63}$` is enforced and a typo fails with
  `MEM_E_INVALID_INPUT` instead of silently writing into the default space.
  `runMany` acquires in sorted order (no ABBA deadlock).
- **Qwen native fidelity**: `ContextEngine.nativeState()` reports
  `mode: 'native' | 'layered'`; below `nativeTokenLimit` nothing is folded (folding
  is a layered-mode operation), above it the L1.5 layered fold runs. The legacy
  `maxTokens` paging threshold is untouched.
- **Automatic handoff (转生)**: when the session reaches
  `autoRolloverThreshold x nativeTokenLimit`, the tail is distilled into ONE durable
  L1.5 summary (`status:handoff`), `state/handoff.json` is marked active and the
  `memory-state` prompt appends `[交接标记] … 本插件不能保证一个会话永生不死，只能
  保证人格不死。`. A new session consumes the marker. Handoffs are idempotent (one
  summary per handoff) and self-trigger from the `session/event` stream and from
  tool boundaries. With `autoRolloverEnabled: false` no marker is written and
  ContextEngine force-evicts at 95% (`reason: 'native-force'`, down to
  `target x nativeTokenLimit`).
- **Panel/status**: `panel.session` (`mode`, `tokens`, `nativeTokenLimit`,
  `threshold`, `remainingTokens`, `rolloverEnabled`, `handoffActive`, …) and
  `panel.spaces` (`current`, `ids`, `open`) are part of the UI contract.

### Added — module 3: atomic cross-space transfer

- **`memory_space_transfer` tool** (`event_ids`, `target_space_id`,
  `transfer_mode: 'copy' | 'move'` default copy, optional `source_space_id`) and
  `Memory.transferEvents()`.
- **Safety rails enforced by the engine, not the caller**: privacy screening aborts
  the whole batch with **`MEM_E_PRIVACY_BLOCKED`** (ID cards, CN phones, bank cards,
  emails, credential assignments, PEM private keys; matched bytes never leave the
  scanner) before any write; `raw_turn` / `rawTurn` / `raw_*` pointers are stripped
  from meta at every depth; the TARGET space regenerates `event_id`s
  (`dedupe:false`, never reuses the source identity) and tags copies
  `transferred:from:<source>` + `transferred:to:<target>`.
- **State difference**: `copy` leaves the source untouched (`state: 'retained'`);
  `move` parks the source ids in the **two-phase pending_delete queue**
  (`state: 'pending_delete'`, `dueAt`, cancellable with `restore`) only after every
  target write succeeded — never a direct physical delete, and a partial target
  failure leaves the source untouched.
- **HTTP**: `POST /api/hippocampus/transfer` (same-origin, validated body) for the
  UI migration button.

### Added — module 4: UI

- **Space panel**: soft-follow toggle (`context.autoSpaceFollow`), auto-rollover
  toggle, trigger-ratio slider, native-window field, single-tag index cap control,
  and a live status bar: `[当前: 原生模式 | 剩余 X Tokens 触发交接]` (also
  `分层折叠` / `已交接` variants).
- **Migration interaction**: copy/cut (复制/剪切) toggle next to the transfer button;
  choosing 剪切 requires a **second confirmation warning** before any request is
  sent.
- **Philosophy footer** (bold, bottom of the settings page): **本插件不能保证一个
  会话永生不死，只能保证人格不死。**
- **Subtraction**: the tag search box uses the host-native Enter key only — no
  debounce, no timer, no effect. `filterGraphByQuery` is pure and testable; the
  force layout is not re-run by filtering.

### Changed

- `uiConfig` exposes `index`; `Memory.applyLiveConfig()` projects a validated config
  onto the facade **and every open child space**, including the context engine's
  native/rollover overrides.
- `Memory` opens child spaces lazily with the same policy input; `close()` closes
  children first; a child failure never blocks the rest.
- The `memory-state` prompt only gains the handoff block when a marker is active,
  so the cache-stable prefix is unchanged in the common case.

### Tests

- New files: `v150.index.test.js` (truncation/degradation/super-tag gate),
  `v150.space.test.js` (per-space concurrency, native boundary, forced eviction),
  `v150.transfer.test.js` (copy/move state difference, privacy, raw_turn strip,
  fresh ids), `v150.ui.test.js` (bundle contract, helpers, no debounce, footer,
  transfer route), `v150.lifecycle.test.js` (Qwen mode, threshold handoff, marker
  consumption, `targetSpaceId` isolation, ninth tool surface),
  `v150.config.test.js` (new groups, ranges, HTTP editability).
- Intentional contract updates in old tests: 8 -> 9 tools, 4 -> 5 routes,
  `panel.session`/`panel.spaces` added to the panel snapshot, manifest 1.5.0.
- Full suite: **253 tests, 253 pass, 0 fail** (old 200 cases included unchanged).

## [1.4.3] — 2026-11-02

Two measured blockers from the 2026-11-02 handoff, both fixed and locked by tests.

### Added

- **`raw.maxScanTurns` config (500–50000, default 5000)**: `deep_raw`'s scan budget
  was a hidden constant and is now a validated, UI-editable knob (`raw.maxScanTurns`).
- **`stage()` / `commitMany()`**: remember is now a `stage -> commitMany` composition.
  `stage()` validates and builds a record (identity + idempotency, no log/index I/O);
  `commitMany()` performs ONE durable append, ONE ledger checkpoint and ONE index
  delta for a whole batch. `bulkIngest` uses it, so a 50-item chunk is one write
  instead of 50.
- **`memory-state` prompt is now composed** via `composePrompt`: stable rules →
  `[Memory Map]` (active tags + counts) → `[Memory Blocks]` (the only per-turn
  volatile tail). The old single-line `briefing()` is no longer the prompt body
  (it changed on every write and broke the prefix cache). Full-chain tests lock the
  prefix to be byte-identical before/after a recall injects a block.
- **`scripts/confidence-ab.mjs`**: local A/B benchmark for `context.minInjectConfidence`
  (100 noise + 10/3 relevant; characters, hits, low-confidence hints, mis-degraded
  relevant memories). Run it with `node scripts/confidence-ab.mjs`.
- **Crash-restart test**: kills the process inside the 200ms checkpoint window
  (cancelled timer, no `close()`), reopens the same directory, and asserts the fresh
  instance reports `stale` (`unflushed-bytes`), rebuilds the index and can recall the
  unflushed tail.

### Fixed

- **`injectRecall()` crashed on any L3 semantic hit**: it used `summary.id` while
  `rankSemantic()` returns `summaryId`, so a recall with a distilled summary and
  `context.injectPrompt` failed with `MEM_E_IO: ContextEngine.inject requires an id`.
  Now it uses `summaryId ?? id` and skips invalid summaries. Found by the new
  prompt/tag-tree full-chain test.
- `logStore.status()` now exposes `unflushedBytes` (shard size minus manifest bytes)
  so an unclean shutdown cannot hide the uncheckpointed tail behind equal counters.

### Changed

- **`deep_raw` scans NEWEST-FIRST** (per shard, tail to head). The old head-first
  scan burned its whole budget on the oldest 5000 turns of a day file — in a 10k
  shard the newest turn could never be found. A hit beyond the window now returns
  `truncated: true` with a note instead of pretending the turn does not exist.
- **Buffered log append**: the hot path keeps one append handle without fsync +
  manifest rewrite per record. A 200ms checkpoint (and `close()`, and any
  rewrite/compaction) fsyncs and publishes the manifest; `status().unflushedBytes`
  plus the boot check make a mid-burst crash visible as stale instead of silently
  "up to date".
- **Identity ledger checkpoint is debounced** (500ms / `close()`): it is a derived
  startup hint rebuilt from the log, so rewriting it per append was pure O(n²) cost.
- **Index appends are lazy**: `applyRecords` records the delta and marks the view
  dirty; the next `snapshot()` folds it once. N writes cost one index build, and
  read-your-writes still holds because the fold happens on the read path.
- **Briefing is dirty-driven**: a write marks the prompt-state line stale; the next
  `briefing()` / panel poll rebuilds it once instead of every append.

### Measured

- Sequential `memory.remember` x1000: **119/s -> 9104/s** (8.4s -> 110ms).
- 10,000-line raw shard, newest query: **0 hits -> 1 hit** (`deep_raw` now starts at
  the tail; hash restore and redaction regression-guarded).
- **`deep_raw` tail-scan bias documented**: beyond `raw.maxScanTurns` (default 5000)
  per shard, only the newest N turns are covered; older history needs a larger budget
  or time-window pagination (`end_time` moved backwards). `truncated: true` + notes
  always say so.
- **Confidence A/B (measured)**: `minInjectConfidence=0.6` cuts the tool payload by
  **49.7%** (10 relevant / 100 noise) and **75.8%** (3 relevant / 100 noise), with
  **0 relevant hits mis-degraded**; the prompt window only shrinks when the top-8
  contains noise (0% vs 59.7% in the two scenarios), so the honest claim is
  "long-tail payload + anti-hallucination", not "always fewer prompt tokens".
- 197 tests green (was 189); after the prompt/tag-tree full-chain wiring and the
  crash-restart test: **200**.

## [1.4.2] — 2026-11-01

### Added

- **L1.5 标签层级树**: hierarchical tags (`tech/frontend/vue3`) now have a
  three-level lifecycle — immortal roots, leaves that die when their reference
  count reaches zero, and mids that enter a grace window when they lose their last
  child. A mid inside that window is a **ghost**: it can be revived by a new leaf,
  and it is what the UI's history view shows. The tree is a **derived cache**
  (`state/tag-tree.json`) built by `maintain()` from the converged index; the
  previous cache is carried forward (`refCount = 0`, orphans dropped) so the
  lifecycle is observable across maintenance runs. Deleting the file loses only
  ghost history.
- **Bounded prune queue**: dead leaves are queued and consumed one
  `tagTree.pruneBatchSize` batch per maintenance run; the remaining queue is
  persisted in the same atomic write, so a 10k-leaf storm drains across runs
  instead of causing a maintenance storm.
- **Anti-hallucination recall degradation**: a `memory_recall` hit reached only
  through a fading mid is **removed from `hits` entirely** (body, snippet and score
  never reach the model or the prompt window) and replaced by one metadata hint per
  mid: path, count, remaining grace days and the exact `deep_raw` time window. A
  query that names a fading mid with no live episode returns a `count: 0` hint
  instead of silence.
- **`panel.tagTree`**: node/root/mid/leaf/ghost/queue counts for the Web panel, and
  `GET /api/hippocampus/graph` now returns `tagTree.ghosts` in the same response as
  the cached graph.
- **UI**: `tagTree.*` sliders with numeric boxes and hover tooltips in the settings
  section; ghost nodes rendered in the force graph as translucent dashed circles
  hanging under their parent root, with a `仅活跃 / 历史全貌` toggle that cross-fades
  them via CSS opacity (the force layout does not re-run when toggling).
- **Config `tagTree` group** (fail-fast, editable over HTTP and in the UI):
  `midHalfLifeMultiplier` (1–10), `midGracePeriodDays` (7–180),
  `pruneBatchSize` (10–500), `leafDecayFloor` (0–1). `midHalfLifeMultiplier` is the
  only source of the mid half-life — no silent hard-coded lifetime.

### Changed

- `maintain()` now rebuilds/prunes/persists the tag tree after the index
  generation converges; a tag-tree failure is reported as `report.tagTreeError`
  and can never fail maintenance or block recall.
- `applyConfig` now projects the validated config onto the running `Memory` facade,
  so live UI edits (raw limits, tagTree lifetimes, …) actually reach the running
  objects instead of waiting for a reload.
- `pruneBatch` re-derives decay against the pass's `now` (a frozen build-time score
  made grace windows meaningless), rejects `O(mids × nodes)` rescans, and keeps
  parent child counts truthful when a mid dies.

## [1.4.1] — 2026-11-01

### Added

- **Prompt discipline (soft interception)**: a static `memory:policy` section tells
  the model to prefer `memory_recall` for history/files/system facts, and to treat
  a `[Slimmed]` response as an invitation to answer from the summary unless the
  `recovery_hash` must be dereferenced.
- **Own-tool output slimming**: `memory_recall`/`memory_admin` responses over the
  budget (default 2000 tokens) are captured to raw first, then returned as
  `{slimmed, summary, topics, key_entities, recovery_hash, hint}`; the hint points
  at `memory_recall(mode="deep_raw", hash=…)`, which restores the exact payload.
- **Retrieval confidence**: hits below `context.minInjectConfidence` (default 0.6)
  carry a short hint instead of their full body, plus a `low-confidence-hints:N` note.
- **Write flood guard**: writes above 80% of `storageBudgetMb` throw
  `MEM_E_WRITE_FLOOD`; `memory.bulkIngest` chunks 50 items per await and ships as
  `memory_bulk_ingest`.
- **raw.captureRatio** (0 | 0.5 | 1): deterministic sampling by content hash;
  ratio 0 disables capture and `deep_raw` returns an explicit warning.

### Changed

- `memory_recall` gains `hash` (exact raw restore) and confidence fields; deep_raw
  results honour the token budget before returning.
- `promptLayout` composes stable rules → memory map → `[Memory Blocks]` tail.

## [1.4.0] — 2026-10-31

### Added

- **Raw-turn forensics (`memory_capture`, `memory_recall mode:"deep_raw"`)**: a
  separate day-sharded JSONL store (`raw/`) that is never indexed, never loaded at
  boot, and never touched by normal recall. Gated by `raw.mode` (default
  `salience`: high-salience, code, stack traces, tool output, or `force`), deduped
  by content hash, secret-redacted, and capped by `maxTurnKb` (head+tail
  truncation), `maxBytesPerDay`, `maxTotalMb`, and `retentionDays` (pruned by
  maintenance; code shards keep 90 days). `deep_raw` scans newest→oldest under a
  byte/turn budget and reports `truncated: true` instead of pretending it saw
  everything.
- **Spaced repetition**: engine-owned schedule (`1,2,4,7,15,30` days) persisted in
  `state/reviews.json`; `maintain()` reconciles due items and `reinforce` advances
  the step. Exposed as `memory_admin action="reviews"`.
- **Two-phase delete**: `forget` parks the event for `delete.graceHours`
  (default 24) in `pending_deletes`; `restore` cancels it, and `maintain()`
  promotes expired requests into the 4-phase pipeline. Unknown ids now fail
  immediately, before parking.
- **UI data-dir migration**: `dataDir` is editable in the settings page. Saving it
  takes `.migration.lock`, returns HTTP 202 with `state=migrating`, copies with
  `fs.promises.cp` in the background, verifies `recordCount` on both sides, and
  only then switches and reloads the store. A mismatch removes the target and
  keeps the old store authoritative; the source is never deleted.
- New config groups: `raw.*`, `delete.graceHours`, `review.enabled`,
  `migration.timeoutMs` (all fail-fast validators, UI tooltips included).
- **Raw-turn black box (minimal schema)**: each line is exactly
  `{turn_id, timestamp, role, content}` — no tags, salience, decay, event ids,
  graph links, session ids or metadata. Addressing is by `(day file, line number)`;
  append-only keeps lines stable (the one lawful line-pointer exception).
  Writes are queued and flushed in batches (10 records / 1s), never sync.
- **Read-side redaction**: the shard keeps 100% plaintext (forensic integrity);
  secrets are redacted when `deep_raw` returns snippets, before any text reaches a
  model prompt. README states local storage is plaintext.
- **Tombstones**: a committed purge appends `raw_tombstone {hash, timestamp}`;
  scans skip tombstoned content hashes (no resurrection).
- **deep_raw constraints**: `start_time` and `end_time` are mandatory (missing →
  `MEM_E_INVALID_INPUT`), results are capped by `raw.maxResultTokens` (default
  1000) and carry the truncation notice when cut.
- **TTL**: maintenance deletes whole day files strictly older than
  `today - raw.retentionDays`; today's shard is never touched. Raw bytes are
  surfaced as `panel.storage.rawBytes` and counted in the dashboard ring.
- **Automatic raw capture**: the plugin subscribes to `dsh-session`'s
  `session/event` and stores every user/assistant surface message verbatim
  (`raw.autoCapture: true`). The Host-injected `Current runtime context.` block is
  stripped out of `content` and kept (truncated) in `metadata.runtimeContext`, so
  `deep_raw` stays signal-clean. Tool output is opt-in (`raw.captureTools: false`),
  **except failed tool results** (`isError`), which are always captured as
  `kind: "error"`. Budgets, dedupe and retention still apply.

### Changed

- Panel adds `raw`, `reviews`, and `pendingDeletes`; the settings page renders a
  migration progress card while `state=migrating`.
- `Memory._scheduler` cron now reads `runtime.config` per tick, so a hot config
  update changes the schedule without a restart.

## [1.3.1] — 2026-10-30

### Fixed

- **Cold-start 404 (root cause)**: `webServer` is provided by the web-app row, which
  activates *after* this plugin's `apply()`. The old code called
  `ctx.get('webServer')` once and silently skipped registration when it was
  absent — every cold start had no routes, while a warm reload worked. Route
  registration now lives in `ctx.inject(['webServer'], child => …)`, so the child
  fiber activates the moment the service appears and the routes are always
  mounted. Verified live (404 → 200) and covered by a deferred-inject test.
- **Front-end death spiral**: a bodiless 404 used to be synthesized into a JSON
  error, which the old retry counter treated as a protocol failure and gave up
  after six attempts. `getJson` now keeps "no JSON" distinct, and the pure
  `decideRetry` policy retries bodiless 404s with exponential backoff (capped at
  5s) for up to 10 minutes before surfacing `MEM_E_BOOT_TIMEOUT` with a manual
  reconnect button.
- **Diagnostics**: `apply()` prints `[Hippocampus] Route registered at <iso>
  (<paths>) phase=<phase>` when the routes are mounted, and
  `[Hippocampus] Route registration FAILED: <reason>` if the service never
  provides one.

## [1.3.0] — 2026-10-30

### Added

- **Context folding (推币机)**: blocks evicted from the context window are no longer
  dropped. A light rule folds the most recent batch into one `folded_summary`
  episode tagged `status:folded` — extracting names, task statements and core
  conclusions — and writes it back to the L1 log.
- **Graph association (在线联想)**: when a query touches a tag, retrieval reads the
  cached graph and pulls that tag's three strongest neighbours into the candidate
  pool with an explicit `penalty: 0.5`; such hits are marked `association.via` and
  can never outrank a direct hit.
- **Monthly memos (月记)**: `maintain()` condenses a finished natural month into one
  `status:monthly` episode. Memos do not decay (`decay = 1`) and are pulled in
  first for fuzzy historical queries ("上个月", "2023-10", "去年" …).

### Changed

- HTTP routes are now registered **before** tools, prompts and scheduling inside
  `apply()`, so a page that wins the boot race hits a live handler answering
  `state=pending` instead of a 404. The Host-side assumption is documented in the
  code: `apply()` awaits nothing, and route service is expected once it returns.

## [1.2.0] — 2026-10-30

### Added

- **`memory_checkpoint`** (`task_id`, `progress`, `updated_at`): exactly one active
  heavy task. A new checkpoint demotes the previous one, one not refreshed for
  seven days is demoted by `maintain()`, and `memory_admin action="active_task"`
  reads it straight from the index — the active-set cap of 200 does not apply.
- **Multimodal pointers**: `memory_remember` accepts `media_url` (absolute path or
  http(s) URL) plus `media_type` (`image|video|document|audio`). Inline base64 in
  `content` is rejected with `MEM_E_INVALID_MEDIA` from 256 consecutive base64
  characters; 200 characters is still ordinary text.
- **`decay.halfLifeDays`** (default 30, 7–365) and **`activeSet.cap`** (default 200,
  100–1000): both declared in `DEFAULT_CONFIG`, validated fail-fast by
  `resolveConfig`, projected into `policy`, and editable from the settings page.
- **State handshake**: every route response now carries `state`
  (`pending|in_progress|ready|failed`), and the UI retries on `state` rather than
  on the HTTP status. A bodiless 404 during boot is treated as `pending` for a
  120s grace window (the routes are only mounted once the Host runs `apply()`).

### Changed

- Writes before READY are refused loudly: `POST /api/hippocampus/config` answers
  `409` with `MEM_E_NOT_READY` and the current state; tools already answered
  `MEM_E_NOT_READY`, and their error details now include `state` and `retryable`.
- The settings page covers the full editable surface (18 keys), with the documented
  hints for `storageBudgetMb`, `context.maxTokens`, `decay.halfLifeDays` and
  `activeSet.cap`; saving before READY is disabled in the UI and rejected by the API.

## [1.1.0] — 2026-10-29

### Added

- **Graph dragging**: nodes are movable with pointer events. The dragged node is
  pinned for the duration, coordinates are mutated in a ref and painted straight
  to the DOM (no `setState` per frame), and release unpins it and runs a short
  alpha relaxation over its 1-hop neighbourhood. A pointer travel under 4px is
  still a click, so selecting a label can never move the node by accident.
- **`storageBudgetMb`** (integer, default 50, range 10–1000): the storage ring's
  budget is now configurable instead of hard-coded, and the ring recomputes the
  moment the value is saved.
- **Full settings UI**: every editable config key is in the settings section —
  switches for booleans, bounded number inputs, a select for
  `identity.eventTimePolicy`, and a text field for the maintenance cron. Saving
  posts one dotted-path patch through the same fail-fast validator as startup;
  a rejected value shows a red banner with the `MEM_E_CONFIG_*` code and nothing
  is applied. A successful save broadcasts `config-changed` so the panel
  refetches stats and graph immediately.

### Fixed

- Dotted config paths deeper than one level (`identity.eventTimePolicy`,
  `retrieval.topK`) now nest correctly instead of producing a literal key.

## [1.0.0] — 2026-10-29

First public release. The package was previously developed under the working
names `@local/dsh-memory` / `Layers-Hippocampus`; the data directory is
unchanged and legacy folders are migrated automatically.

### Added

- **Layers**: append-only event log, rebuildable tag index (A/B generations),
  day diaries, independent semantic layer, L2.5 trend quarantine with promotion
  and burst detection.
- **Identity discipline**: canonical `content_hash`, `event_id =
  hash(content_hash + event_time + occurrence_index)`, separate idempotency
  index, tombstones that survive log compaction.
- **Context paging**: token budget, eviction thresholds, cumulative saved-token
  accounting persisted in `state/context.json`.
- **Maintenance**: one gate for cron and Dream (`runtime.runMaintenance`), no
  queueing and no backfill; a missed window is skipped, not replayed.
- **Config fail-fast**: `enableDream`, `dreamIdleMinutes`, `enableReflection`,
  `graphMaxEdges` (100–2000, default 500), cron, context and temp ranges are
  validated by `resolveConfig`; HTTP hot updates go through the same validator.
- **Async startup state machine** `pending → in_progress → ready | failed`, with
  `POST /api/hippocampus/retry` and a UI retry banner.
- **Offline knowledge graph**: built at the end of `maintain()` from the index
  (log minus tombstones), per-node Top-N neighbours, global weight order, cached
  at `state/graph.json`, hard cap 2000 edges.
- **Web UI**: sidebar icon, main panel (SVG storage ring, stats, force-directed
  graph with progressive reveal), and a settings section.
- **HTTP API** (same-origin, behind the Host's browser auth):
  `GET /api/hippocampus/stats`, `GET|POST /api/hippocampus/config`,
  `GET /api/hippocampus/graph`, `POST /api/hippocampus/retry`.
- **Tests**: 106 in-process cases (Node `node:test`) covering identity,
  retrieval, L2.5, maintenance, migration, routes, graph and the client bundle
  contract.

### Security

- The UI never receives credentials and never calls agent tools; every number is
  read through the Host's authenticated JSON routes.
- The graph route returns at most `graphMaxEdges` edges from a cached file — no
  query language, no path input.

[1.0.0]: https://github.com/382quaii/dsh-Layers-Hippocampus/releases/tag/v1.0.0

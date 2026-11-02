# Changelog

All notable changes to `dsh-layers-hippocampus` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

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

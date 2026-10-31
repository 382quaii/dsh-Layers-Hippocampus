# Changelog

All notable changes to `dsh-layers-hippocampus` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

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

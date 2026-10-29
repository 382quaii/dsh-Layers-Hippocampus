# Changelog

All notable changes to `dsh-layers-hippocampus` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

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

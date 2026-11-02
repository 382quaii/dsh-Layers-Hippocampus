#!/usr/bin/env node
/**
 * Handoff dirty-data repair (v1.5.4).
 *
 * The recursion incident produced handoff summaries that contain previous handoff
 * summaries (and generations whose ratio climbed past the native window). This
 * tool finds them and parks them in the TWO-PHASE pending-delete queue — it never
 * physically purges on the spot and never touches normal memories.
 *
 * Safety:
 *   - DRY RUN by default; `--apply` is required to write.
 *   - Only events tagged `status:handoff` are candidates.
 *   - The newest `--keep` generation(s) are retained (default 1).
 *   - Physical deletion still happens later through the normal maintain/grace
 *     pipeline, so a wrong call is cancellable with memory_restore in time.
 *
 * Usage:
 *   node scripts/repair-handoff.mjs --data-dir "<absolute store dir>"
 *   node scripts/repair-handoff.mjs --data-dir "<dir>" --apply --keep 1
 *   node scripts/repair-handoff.mjs --data-dir "<dir>" --reset-marker
 *
 * NOTE: stop the DSH host (or accept that its in-memory view is stale) before
 * `--apply`; this script opens the same store directly.
 */
import path from 'node:path';
import { Memory } from '../src/memory.js';

function parseArgs(argv) {
  const options = { dataDir: null, apply: false, keep: 1, resetMarker: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--data-dir') options.dataDir = argv[++index];
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--keep') options.keep = Number(argv[++index]);
    else if (arg === '--reset-marker') options.resetMarker = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('node scripts/repair-handoff.mjs --data-dir <abs> [--apply] [--keep 1] [--reset-marker] [--json]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!options.dataDir || !path.isAbsolute(options.dataDir)) {
    console.error('--data-dir must be an absolute path (it is the memory store directory, e.g. <DSH_HOME>/memory)');
    process.exit(2);
  }
  if (!Number.isInteger(options.keep) || options.keep < 0) {
    console.error('--keep must be a non-negative integer');
    process.exit(2);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const memory = await Memory.open({ dataDir: options.dataDir });
try {
  const result = await memory.repairHandoffSummaries({ dryRun: !options.apply, keep: options.keep });
  const marker = options.resetMarker ? memory.clearHandoff({ reason: 'repair-script' }) : null;
  const report = {
    dataDir: options.dataDir,
    dryRun: result.dryRun,
    totalHandoff: result.totalHandoff,
    recursive: result.recursive,
    candidates: result.candidates,
    pendingDelete: result.forget?.status ?? result.forget?.queued ?? null,
    markerReset: marker?.cleared === true,
  };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`store: ${report.dataDir}`);
    console.log(`handoff events: ${report.totalHandoff} · recursive: ${report.recursive} · candidates: ${report.candidates.length}`);
    for (const id of report.candidates) console.log(`  - ${id}`);
    console.log(report.dryRun ? 'DRY RUN: no write. Re-run with --apply to park them in pending_delete.' : `Applied: parked in pending_delete (${report.pendingDelete ?? 'queued'}).`);
    if (report.markerReset) console.log('active handoff marker: consumed/reset');
  }
} finally {
  memory.close();
}

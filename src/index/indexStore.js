/**
 * Index store: double-buffered, generation-addressed read model.
 *
 * Publishing is atomic and non-blocking for readers:
 *   1. build `gen-N` in a temp directory (all files, fsynced)
 *   2. rename the temp dir to `gen-N`   (invisible until step 3)
 *   3. atomically replace `index/CURRENT` with `gen-N`
 *
 * A reader resolves CURRENT once per query and then reads immutable files, so it
 * either sees the whole previous generation or the whole next one. No reader lock,
 * no partial state, and maintenance never blocks retrieval — which is the top
 * priority in the brief's conflict order.
 */

import fs from 'node:fs';
import path from 'node:path';
import { MemoryError, ErrorCodes } from '../errors.js';
import {
  ensureDir,
  fsyncDir,
  listGenerations,
  nextGenerationName,
  readJson,
  readText,
  writeFileAtomic,
  writeJsonAtomic,
} from '../util.js';

const FILES = {
  events: 'events.json',
  tags: 'tags.json',
  activeSet: 'active-set.json',
  diary: 'diary.json',
  tombstones: 'tombstones.json',
  aliases: 'aliases.json',
  manifest: 'manifest.json',
};

export class IndexStore {
  constructor({ root, cacheSize = 2 }) {
    this.root = root;
    this.cacheSize = cacheSize;
    this._cache = new Map(); // gen -> view
    ensureDir(root);
  }

  currentGeneration() {
    const text = readText(path.join(this.root, 'CURRENT'));
    if (!text) return null;
    const gen = text.trim();
    if (!/^gen-\d{6}$/.test(gen)) {
      throw new MemoryError(ErrorCodes.INDEX_CORRUPT, 'index CURRENT pointer is malformed', { value: gen });
    }
    return gen;
  }

  /**
   * Load the current generation.
   * @returns {object|null} view with `generation`, or null when no index exists.
   */
  current() {
    const gen = this.currentGeneration();
    if (!gen) return null;
    const cached = this._cache.get(gen);
    if (cached) {
      // touch for LRU eviction
      this._cache.delete(gen);
      this._cache.set(gen, cached);
      return cached;
    }
    const dir = path.join(this.root, gen);
    const manifest = readJson(path.join(dir, FILES.manifest));
    if (!manifest) {
      throw new MemoryError(ErrorCodes.INDEX_MISSING, 'index generation has no manifest', { gen });
    }
    const view = {
      generation: gen,
      manifest,
      builtAt: manifest.builtAt,
      policyHash: manifest.policyHash,
      sourceLogGen: manifest.sourceLogGen,
      events: readJson(path.join(dir, FILES.events), []),
      tags: readJson(path.join(dir, FILES.tags), {}),
      activeSet: readJson(path.join(dir, FILES.activeSet), { cap: 0, entries: [], evicted: [], churn: {} }),
      diary: readJson(path.join(dir, FILES.diary), { blocks: [] }),
      tombstones: readJson(path.join(dir, FILES.tombstones), {}),
      aliases: readJson(path.join(dir, FILES.aliases), {}),
      stats: manifest.stats ?? {},
    };
    this._cache.set(gen, view);
    while (this._cache.size > this.cacheSize) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
    return view;
  }

  /**
   * Publish a freshly built index as the next generation.
   * @param {object} index result of buildIndex()
   * @param {{sourceLogGen: string|null}} meta
   * @returns {{gen: string, manifest: object}}
   */
  publish(index, meta = {}) {
    const gen = nextGenerationName(this.root);
    const dir = path.join(this.root, gen);
    const tmp = path.join(this.root, `.tmp-${gen}-${Date.now().toString(36)}`);
    ensureDir(tmp);

    writeJsonAtomic(path.join(tmp, FILES.events), index.events);
    writeJsonAtomic(path.join(tmp, FILES.tags), index.tags);
    writeJsonAtomic(path.join(tmp, FILES.activeSet), index.activeSet);
    writeJsonAtomic(path.join(tmp, FILES.diary), index.diary);
    writeJsonAtomic(path.join(tmp, FILES.tombstones), index.tombstones);
    writeJsonAtomic(path.join(tmp, FILES.aliases), index.aliases);

    const manifest = {
      v: 1,
      gen,
      builtAt: index.builtAt,
      policyHash: index.policyHash,
      sourceLogGen: meta.sourceLogGen ?? index.sourceLogGen ?? null,
      previousGeneration: this.currentGeneration(),
      stats: index.stats,
    };
    writeJsonAtomic(path.join(tmp, FILES.manifest), manifest);

    fs.renameSync(tmp, dir);
    fsyncDir(this.root);
    writeFileAtomic(path.join(this.root, 'CURRENT'), `${gen}\n`);
    fsyncDir(this.root);

    const view = {
      generation: gen,
      manifest,
      builtAt: index.builtAt,
      policyHash: index.policyHash,
      sourceLogGen: manifest.sourceLogGen,
      events: index.events,
      tags: index.tags,
      activeSet: index.activeSet,
      diary: index.diary,
      tombstones: index.tombstones,
      aliases: index.aliases,
      stats: index.stats,
    };
    this._cache.set(gen, view);
    while (this._cache.size > this.cacheSize) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
    return { gen, manifest };
  }

  /** Retire old generations, keeping the newest `keep` (current is always kept). */
  prune({ keep = 2 } = {}) {
    const gens = listGenerations(this.root);
    const current = this.currentGeneration();
    const removable = gens.filter((gen) => gen !== current).slice(0, Math.max(0, gens.length - keep));
    const removed = [];
    for (const gen of removable) {
      fs.rmSync(path.join(this.root, gen), { recursive: true, force: true });
      this._cache.delete(gen);
      removed.push(gen);
    }
    return removed;
  }

  status() {
    const gen = this.currentGeneration();
    if (!gen) return { gen: null };
    const manifest = readJson(path.join(this.root, gen, FILES.manifest), {});
    return {
      gen,
      builtAt: manifest.builtAt ?? null,
      policyHash: manifest.policyHash ?? null,
      sourceLogGen: manifest.sourceLogGen ?? null,
      generations: listGenerations(this.root).length,
      stats: manifest.stats ?? {},
    };
  }
}

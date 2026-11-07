/**
 * Compression-engine abstraction for the raw cold tier (v1.6.1, zero dependencies).
 *
 * The DEFAULT engine is `gzip` from Node's built-in `node:zlib`. `zstd` is also
 * built into modern Node (22+): when the runtime exposes it, an operator may switch
 * `raw.compressionEngine` to `zstd` for a better ratio WITHOUT installing anything.
 *
 * Older runtimes simply report zstd as unavailable and stay on gzip — the raw tier
 * never depends on an external package.
 */

import zlib from 'node:zlib';

export const COMPRESSION_ENGINES = Object.freeze(['gzip', 'zstd']);

/** Extension for a monthly archive produced by the given engine. */
export function archiveExtension(engine = 'gzip') {
  return engine === 'zstd' ? '.jsonl.zst' : '.jsonl.gz';
}

/** Engine that produced an existing archive file (by extension). */
export function engineForArchive(name) {
  return String(name).endsWith('.jsonl.zst') ? 'zstd' : 'gzip';
}

export function isArchiveFile(name) {
  return /^raw-archive-\d{4}-\d{2}\.jsonl\.(gz|zst)$/.test(String(name));
}

/** Runtime capability probe (never throws). */
export function probeCompression() {
  return {
    gzip: typeof zlib.createGzip === 'function',
    zstd:
      typeof zlib.createZstdCompress === 'function' &&
      typeof zlib.createZstdDecompress === 'function',
    node: process.version,
  };
}

/** Resolve the configured engine to a usable one (silent fallback to gzip). */
export function resolveEngine(requested, probe = probeCompression()) {
  const wanted = String(requested ?? 'gzip');
  if (wanted === 'zstd' && probe.zstd) return { engine: 'zstd', fallback: false, probe };
  if (wanted === 'zstd' && !probe.zstd) return { engine: 'gzip', fallback: true, probe };
  return { engine: 'gzip', fallback: false, probe };
}

/** Compressor stream for writing one archive. */
export function createCompressStream(engine = 'gzip') {
  if (engine === 'zstd') {
    if (typeof zlib.createZstdCompress !== 'function') throw new Error('zstd compression is unavailable in this Node runtime');
    return zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 6 } });
  }
  return zlib.createGzip({ level: 6 });
}

/** Decompressor stream for reading one archive. */
export function createDecompressStream(engine = 'gzip') {
  if (engine === 'zstd') {
    if (typeof zlib.createZstdDecompress !== 'function') throw new Error('zstd decompression is unavailable in this Node runtime');
    return zlib.createZstdDecompress();
  }
  return zlib.createGunzip();
}

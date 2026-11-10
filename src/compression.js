/**
 * Compression-engine abstraction for the raw cold tier (v1.6.1, zero dependencies).
 *
 * Three engines, all from Node's built-in `node:zlib` — nothing is installed:
 *
 *   - `gzip`   : the conservative default-compatible engine (level 6);
 *   - `brotli` : the DEFAULT for cold archives — Brotli quality 11 ("极限压缩"),
 *                typically the best ratio for JSONL text;
 *   - `zstd`   : available on Node 22+; faster decode, ratio between the two.
 *
 * An old runtime that lacks an engine falls back to gzip and reports `fallback`,
 * so the raw tier can never hard-depend on an optional codec.
 */

import zlib from 'node:zlib';

export const COMPRESSION_ENGINES = Object.freeze(['brotli', 'gzip', 'zstd']);

/** Extension for a monthly archive produced by the given engine. */
export function archiveExtension(engine = 'brotli') {
  if (engine === 'zstd') return '.jsonl.zst';
  if (engine === 'brotli') return '.jsonl.br';
  return '.jsonl.gz';
}

/** Engine that produced an existing archive file (by extension). */
export function engineForArchive(name) {
  const text = String(name);
  if (text.endsWith('.jsonl.zst')) return 'zstd';
  if (text.endsWith('.jsonl.br')) return 'brotli';
  return 'gzip';
}

export function isArchiveFile(name) {
  return /^raw-archive-\d{4}-\d{2}\.jsonl\.(gz|zst|br)$/.test(String(name));
}

/** Runtime capability probe (never throws). */
export function probeCompression() {
  return {
    gzip: typeof zlib.createGzip === 'function',
    brotli:
      typeof zlib.createBrotliCompress === 'function' &&
      typeof zlib.createBrotliDecompress === 'function',
    zstd:
      typeof zlib.createZstdCompress === 'function' &&
      typeof zlib.createZstdDecompress === 'function',
    node: process.version,
  };
}

/** Resolve the configured engine to a usable one (silent fallback to gzip). */
export function resolveEngine(requested, probe = probeCompression()) {
  const wanted = String(requested ?? 'brotli');
  if (wanted === 'zstd' && probe.zstd) return { engine: 'zstd', fallback: false, probe };
  if (wanted === 'zstd' && !probe.zstd) return { engine: 'gzip', fallback: true, probe };
  if (wanted === 'brotli' && probe.brotli) return { engine: 'brotli', fallback: false, probe };
  if (wanted === 'brotli' && !probe.brotli) return { engine: 'gzip', fallback: true, probe };
  return { engine: 'gzip', fallback: false, probe };
}

/** Maximum quality for each engine (the "极限压缩" setting). */
export const ENGINE_MAX_LEVEL = Object.freeze({ gzip: 9, brotli: 11, zstd: 22 });

/** Compressor stream for writing one archive. */
export function createCompressStream(engine = 'brotli', { level = null } = {}) {
  if (engine === 'zstd') {
    if (typeof zlib.createZstdCompress !== 'function') throw new Error('zstd compression is unavailable in this Node runtime');
    const zstdLevel = level ?? 6;
    return zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: zstdLevel } });
  }
  if (engine === 'brotli') {
    if (typeof zlib.createBrotliCompress !== 'function') throw new Error('brotli compression is unavailable in this Node runtime');
    // quality 11 is Brotli's maximum: slow but this path only runs once per month.
    return zlib.createBrotliCompress({
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: level ?? zlib.constants.BROTLI_MAX_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: 1 << 20,
      },
    });
  }
  return zlib.createGzip({ level: level ?? 9 });
}

/** Decompressor stream for reading one archive. */
export function createDecompressStream(engine = 'brotli') {
  if (engine === 'zstd') {
    if (typeof zlib.createZstdDecompress !== 'function') throw new Error('zstd decompression is unavailable in this Node runtime');
    return zlib.createZstdDecompress();
  }
  if (engine === 'brotli') {
    if (typeof zlib.createBrotliDecompress !== 'function') throw new Error('brotli decompression is unavailable in this Node runtime');
    return zlib.createBrotliDecompress();
  }
  return zlib.createGunzip();
}

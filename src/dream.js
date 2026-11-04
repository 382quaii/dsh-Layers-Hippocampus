/**
 * Dream — LLM semantic distillation with an absolute local fallback.
 *
 * Charter v2.0 #1 (zero dependencies) is load-bearing here:
 *   - no SDK is imported; the only network primitive is Node's built-in `fetch`;
 *   - endpoint / model / key are injected through plugin config (or the
 *     `DSH_DREAM_LLM_*` environment), never hard-coded and never logged;
 *   - the call happens ONLY inside `executeDream()` (offline Dream), never on the
 *     online `recall`/`remember` path.
 *
 * The engine is fail-safe by construction: every LLM failure (missing config,
 * network error, timeout, non-JSON output) degrades to a deterministic local
 * merge and records `MEM_E_DREAM_LLM_FALLBACK`. A Dream run can therefore never
 * deadlock and never loses data — the merged record always carries
 * `meta.source_event_ids` pointing back at the exact records it was built from.
 *
 * State is engine-owned (`state/dream.json`): merged source ids (idempotency),
 * per-tag results, and the circuit breaker. It is a cache: deleting it costs a
 * possible re-merge, never the log (the append-only log stays the truth source).
 */

import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic, snippet } from './util.js';
import { ErrorCodes, MemoryError } from './errors.js';

/** Tag carried by every distilled record; also the re-merge guard. */
export const DREAM_TAG = 'status:dream';
export const DREAM_STATE_SCHEMA = 1;
/** Logged whenever an LLM attempt degrades to the local heuristic. */
export const DREAM_FALLBACK_CODE = ErrorCodes.DREAM_LLM_FALLBACK;

/** Tags that must never become distillation groups (bookkeeping, not experience). */
const INTERNAL_TAG_PREFIXES = Object.freeze(['status:', 'month:']);
const INTERNAL_TAGS = Object.freeze(['active_task']);

export const DEFAULT_DREAM_CONFIG = Object.freeze({
  useLlm: true,
  minGroupSize: 3,
  maxGroupsPerRun: 5,
  maxSummaryChars: 200,
  maxSourceChars: 400,
  maxEventsPerGroup: 8,
  llmTimeoutMs: 15_000,
  failureThreshold: 3,
  cooldownMinutes: 60,
  llm: Object.freeze({ baseUrl: null, model: null, apiKey: null }),
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pickString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function finiteInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/**
 * Resolve the Dream options. Config wins, environment is the injection seam for a
 * deployment that keeps secrets out of the profile file, defaults are last. No
 * value is ever clamped silently by the caller — this helper is only reached with
 * an already fail-fast-validated config; direct embedders get bounded defaults.
 */
export function resolveDreamConfig(input = {}, env = process.env) {
  const raw = isPlainObject(input) ? input : {};
  const llmIn = isPlainObject(raw.llm) ? raw.llm : {};
  return {
    useLlm: raw.useLlm === undefined ? DEFAULT_DREAM_CONFIG.useLlm : raw.useLlm === true,
    minGroupSize: finiteInt(raw.minGroupSize, DEFAULT_DREAM_CONFIG.minGroupSize, 2, 50),
    maxGroupsPerRun: finiteInt(raw.maxGroupsPerRun, DEFAULT_DREAM_CONFIG.maxGroupsPerRun, 1, 50),
    maxSummaryChars: finiteInt(raw.maxSummaryChars, DEFAULT_DREAM_CONFIG.maxSummaryChars, 40, 2000),
    maxSourceChars: finiteInt(raw.maxSourceChars, DEFAULT_DREAM_CONFIG.maxSourceChars, 80, 4000),
    maxEventsPerGroup: finiteInt(raw.maxEventsPerGroup, DEFAULT_DREAM_CONFIG.maxEventsPerGroup, 2, 50),
    llmTimeoutMs: finiteInt(raw.llmTimeoutMs, DEFAULT_DREAM_CONFIG.llmTimeoutMs, 500, 120_000),
    failureThreshold: finiteInt(raw.failureThreshold, DEFAULT_DREAM_CONFIG.failureThreshold, 1, 20),
    cooldownMinutes: finiteInt(raw.cooldownMinutes, DEFAULT_DREAM_CONFIG.cooldownMinutes, 1, 1440),
    llm: {
      baseUrl: pickString(llmIn.baseUrl) ?? pickString(env?.DSH_DREAM_LLM_BASE_URL),
      model: pickString(llmIn.model) ?? pickString(env?.DSH_DREAM_LLM_MODEL),
      apiKey: pickString(llmIn.apiKey) ?? pickString(env?.DSH_DREAM_LLM_API_KEY),
    },
  };
}

export function isLlmConfigured(llm = {}) {
  return Boolean(pickString(llm.baseUrl) && pickString(llm.model));
}

/** OpenAI-compatible endpoint; a base URL that already names it is left alone. */
export function chatEndpoint(baseUrl) {
  const base = String(baseUrl).replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

function tagName(entry) {
  return typeof entry === 'string' ? entry : entry?.tag;
}

function isInternalTag(tag) {
  return INTERNAL_TAGS.includes(tag) || INTERNAL_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix));
}

function formatDay(epochMs) {
  const date = new Date(epochMs);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '?';
}

function cleanText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Parse the model's structured reply. Strict on purpose: a free-form answer is an
 * LLM failure and must degrade, not slip into the memory log as "experience".
 */
export function parseDistillation(text, { maxSummaryChars = 200 } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new MemoryError(DREAM_FALLBACK_CODE, 'dream LLM returned an empty answer', { phase: 'format' });
  }
  const fenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new MemoryError(DREAM_FALLBACK_CODE, 'dream LLM answer is not a JSON object', { phase: 'format' });
  }
  let parsed;
  try {
    parsed = JSON.parse(fenced.slice(start, end + 1));
  } catch (error) {
    throw new MemoryError(DREAM_FALLBACK_CODE, `dream LLM answer is not valid JSON: ${error.message}`, { phase: 'format' });
  }
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  if (!summary) {
    throw new MemoryError(DREAM_FALLBACK_CODE, 'dream LLM answer has no non-empty `summary`', { phase: 'format' });
  }
  if (summary.length > maxSummaryChars) {
    throw new MemoryError(DREAM_FALLBACK_CODE, `dream LLM summary exceeds ${maxSummaryChars} characters`, {
      phase: 'format',
      chars: summary.length,
      limit: maxSummaryChars,
    });
  }
  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new MemoryError(DREAM_FALLBACK_CODE, 'dream LLM answer has no valid `confidence` in [0,1]', {
      phase: 'format',
      got: parsed.confidence ?? null,
    });
  }
  return { summary, confidence };
}

/**
 * Deterministic local merge: the absolute fallback. Earliest/latest time plus the
 * deduplicated core text of each source (each capped), then the whole line is
 * capped to `maxSummaryChars` so the log can never be flooded by a fallback.
 */
export function localDistillation(tag, events = [], { maxSummaryChars = 200 } = {}) {
  const ordered = events.slice().sort((a, b) => (a.eventTime ?? 0) - (b.eventTime ?? 0));
  if (ordered.length === 0) {
    throw new MemoryError(ErrorCodes.INVALID_INPUT, 'local dream merge requires at least one source event', { tag });
  }
  const first = formatDay(ordered[0].eventTime ?? 0);
  const last = formatDay(ordered[ordered.length - 1].eventTime ?? 0);
  const seen = new Set();
  const cores = [];
  for (const event of ordered) {
    const core = cleanText(snippet(event.content, 120));
    if (!core) continue;
    const key = core.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cores.push(core);
    if (cores.length >= 3) break;
  }
  let text = `经验·${tag}（${ordered.length} 条 / ${first}~${last}）：${cores.join('；') || '（无可用文本）'}`;
  if (text.length > maxSummaryChars) text = `${text.slice(0, Math.max(1, maxSummaryChars - 1))}…`;
  return { summary: text, confidence: 0.5, mode: 'local' };
}

function systemPrompt(config) {
  return [
    '你是长期记忆蒸馏器。只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释。',
    '输出格式：{"summary":"...","confidence":0.0}',
    `规则：1) summary 必须是 <= ${config.maxSummaryChars} 个字符的中文经验结论，只压缩可复用的根因/做法/教训，严禁编造；`,
    '2) confidence 是 0..1 的数字，表示结论的可信度；',
    '3) 不要输出事件 id、时间戳或来源信息；4) 信息不足时仍输出 JSON，summary 写“经验不足，待补充”。',
  ].join('\n');
}

function userPrompt(tag, sources, config) {
  const lines = sources.map(
    (event, index) => `#${index + 1} (${formatDay(event.eventTime ?? 0)}) ${cleanText(snippet(event.content, config.maxSourceChars))}`,
  );
  return [`标签：${tag}`, `记录（按时间升序，共 ${sources.length} 条）：`, ...lines, '', '请输出 JSON。'].join('\n');
}

/**
 * The offline distillation engine. One instance per Memory (per physical space);
 * `run()` is single-flight: a second concurrent Dream is refused, never queued.
 */
export class DreamEngine {
  constructor({ memory, clock, getConfig, logger = null, fetchImpl = null } = {}) {
    if (!memory) throw new MemoryError(ErrorCodes.INVALID_CONFIG, 'DreamEngine requires a Memory instance');
    this.memory = memory;
    this.clock = clock ?? memory.clock;
    this.getConfig = getConfig ?? (() => ({}));
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.file = path.join(memory.paths.state, 'dream.json');
    this.state = null;
    this._running = false;
  }

  config() {
    return resolveDreamConfig(this.getConfig?.() ?? {});
  }

  _load() {
    if (this.state) return this.state;
    const raw = readJson(this.file, null);
    const base = {
      schema: DREAM_STATE_SCHEMA,
      mergedEventIds: [],
      groups: {},
      circuit: { state: 'closed', consecutiveFailures: 0, openUntil: 0 },
      stats: { runs: 0, merged: 0, llmSuccess: 0, llmFallback: 0, lastRunAt: null },
      lastFallback: null,
    };
    if (!isPlainObject(raw) || raw.schema !== DREAM_STATE_SCHEMA) {
      this.state = base;
      return this.state;
    }
    this.state = {
      ...base,
      ...raw,
      mergedEventIds: [...new Set((Array.isArray(raw.mergedEventIds) ? raw.mergedEventIds : []).filter((id) => typeof id === 'string'))],
      groups: isPlainObject(raw.groups) ? { ...raw.groups } : {},
      circuit: { ...base.circuit, ...(isPlainObject(raw.circuit) ? raw.circuit : {}) },
      stats: { ...base.stats, ...(isPlainObject(raw.stats) ? raw.stats : {}) },
    };
    return this.state;
  }

  _persist() {
    ensureDir(path.dirname(this.file));
    writeJsonAtomic(this.file, this._load());
  }

  _circuitView() {
    const circuit = this._load().circuit;
    return {
      state: circuit.state,
      consecutiveFailures: circuit.consecutiveFailures ?? 0,
      openUntil: circuit.openUntil ?? 0,
    };
  }

  /** True when one LLM attempt is allowed right now (half-open allows exactly one). */
  _circuitAllows(now) {
    const circuit = this._load().circuit;
    if (circuit.state === 'closed') return true;
    if (circuit.state === 'half-open') return true;
    if (now >= (circuit.openUntil ?? 0)) {
      circuit.state = 'half-open';
      return true;
    }
    return false;
  }

  _recordLlmSuccess() {
    const circuit = this._load().circuit;
    circuit.state = 'closed';
    circuit.consecutiveFailures = 0;
    circuit.openUntil = 0;
  }

  _recordLlmFailure(now, config) {
    const circuit = this._load().circuit;
    circuit.consecutiveFailures = (circuit.consecutiveFailures ?? 0) + 1;
    if (circuit.consecutiveFailures >= config.failureThreshold) {
      circuit.state = 'open';
      circuit.openUntil = now + config.cooldownMinutes * 60_000;
    }
  }

  _warn(logger, { tag, reason, at, error }) {
    const message = `[${DREAM_FALLBACK_CODE}] dream LLM fallback: ${reason} (tag=${tag})`;
    this._load().lastFallback = {
      code: DREAM_FALLBACK_CODE,
      reason,
      tag,
      at,
      error: error ? { code: error.code ?? null, message: error.message ?? String(error) } : null,
    };
    logger?.warn?.(message);
  }

  status() {
    const config = this.config();
    const state = this._load();
    return {
      schema: DREAM_STATE_SCHEMA,
      llmConfigured: isLlmConfigured(config.llm),
      circuit: this._circuitView(),
      stats: { ...state.stats },
      groups: Object.keys(state.groups).length,
      mergedSourceIds: state.mergedEventIds.length,
      lastFallback: state.lastFallback ?? null,
    };
  }

  /** Escape hatch: force the breaker closed (used by tests / operator recovery). */
  resetCircuit() {
    this._recordLlmSuccess();
    this._persist();
    return this._circuitView();
  }

  /** Groups of same-tag events that are not yet distilled and not bookkeeping. */
  collectGroups(config) {
    const view = this.memory.indexManager?.snapshot?.();
    const rawEvents = view?.events;
    const events = rawEvents instanceof Map ? [...rawEvents.values()] : Array.isArray(rawEvents) ? rawEvents : [];
    const merged = new Set(this._load().mergedEventIds);
    const byTag = new Map();
    for (const event of events) {
      if (!event || typeof event.eventId !== 'string' || merged.has(event.eventId)) continue;
      const names = (event.tags ?? []).map(tagName).filter(Boolean);
      if (names.includes(DREAM_TAG) || names.some(isInternalTag)) continue;
      for (const tag of new Set(names)) {
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag).push(event);
      }
    }
    return [...byTag.entries()]
      .filter(([, list]) => list.length >= config.minGroupSize)
      .map(([tag, list]) => ({ tag, events: list }))
      .sort((a, b) => b.events.length - a.events.length || a.tag.localeCompare(b.tag));
  }

  async _callLlm({ tag, sources, config, now }) {
    const llm = config.llm;
    if (!isLlmConfigured(llm)) {
      throw new MemoryError(DREAM_FALLBACK_CODE, 'dream LLM is not configured (baseUrl/model missing)', { phase: 'config' });
    }
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') {
      throw new MemoryError(DREAM_FALLBACK_CODE, 'no fetch implementation is available (Node >= 18 required)', {
        phase: 'fetch',
      });
    }
    const controller = new AbortController();
    let timer = null;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new MemoryError(DREAM_FALLBACK_CODE, `dream LLM timed out after ${config.llmTimeoutMs}ms`, {
            phase: 'timeout',
            timeoutMs: config.llmTimeoutMs,
          }),
        );
      }, config.llmTimeoutMs);
      timer.unref?.();
    });
    const request = (async () => {
      const response = await doFetch(chatEndpoint(llm.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: llm.model,
          temperature: 0,
          max_tokens: Math.max(64, Math.ceil(config.maxSummaryChars * 2) + 64),
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt(config) },
            { role: 'user', content: userPrompt(tag, sources, config) },
          ],
        }),
        signal: controller.signal,
      });
      if (!response || response.ok !== true) {
        throw new MemoryError(DREAM_FALLBACK_CODE, `dream LLM HTTP ${response?.status ?? 'unknown'}`, {
          phase: 'http',
          status: response?.status ?? null,
        });
      }
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new MemoryError(DREAM_FALLBACK_CODE, 'dream LLM response carries no message content', { phase: 'format' });
      }
      return content;
    })();
    try {
      const content = await Promise.race([request, timeout]);
      return parseDistillation(content, { maxSummaryChars: config.maxSummaryChars });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async _distillGroup({ tag, events }, { config, now, logger }) {
    const sources = events
      .slice()
      .sort((a, b) => (a.eventTime ?? 0) - (b.eventTime ?? 0))
      .slice(-config.maxEventsPerGroup);
    const sourceEventIds = [...new Set(sources.map((event) => event.eventId))].sort();
    if (sourceEventIds.length === 0) {
      return { tag, eventId: null, distilledBy: 'local', sourceEventIds, fallbackReason: 'no-sources' };
    }

    let summary = null;
    let confidence = 0.5;
    let distilledBy = 'local';
    let fallbackReason = null;
    let failure = null;

    if (config.useLlm && isLlmConfigured(config.llm) && this._circuitAllows(now)) {
      try {
        const result = await this._callLlm({ tag, sources, config, now });
        summary = result.summary;
        confidence = result.confidence;
        distilledBy = 'llm';
        this._recordLlmSuccess();
      } catch (error) {
        failure = error;
        fallbackReason = error?.details?.phase === 'timeout' ? 'timeout' : 'llm-error';
        this._recordLlmFailure(now, config);
        this._warn(logger, { tag, reason: fallbackReason, at: now, error });
      }
    } else if (config.useLlm && !isLlmConfigured(config.llm)) {
      fallbackReason = 'llm-not-configured';
      this._warn(logger, { tag, reason: fallbackReason, at: now });
    } else if (config.useLlm && !this._circuitAllows(now)) {
      fallbackReason = 'circuit-open';
      this._warn(logger, { tag, reason: fallbackReason, at: now });
    }

    if (summary === null) {
      const local = localDistillation(tag, sources, { maxSummaryChars: config.maxSummaryChars });
      summary = local.summary;
      confidence = local.confidence;
      distilledBy = 'local';
    }

    const salience = Math.min(1, Math.max(0.8, ...sources.map((event) => Number(event.salience) || 0)));
    const result = await this.memory.remember({
      content: summary,
      tags: [tag, DREAM_TAG],
      salience,
      eventTime: now,
      meta: {
        dream: true,
        distilled_by: distilledBy,
        source_event_ids: sourceEventIds,
        confidence,
      },
    });
    const eventId = result?.eventId ?? null;
    const state = this._load();
    const merged = new Set(state.mergedEventIds);
    for (const id of sourceEventIds) merged.add(id);
    state.mergedEventIds = [...merged].sort();
    state.groups[tag] = {
      at: now,
      eventId,
      distilledBy,
      confidence,
      sourceEventIds,
      fallbackReason,
    };
    state.stats.merged = (state.stats.merged ?? 0) + 1;
    if (distilledBy === 'llm') state.stats.llmSuccess = (state.stats.llmSuccess ?? 0) + 1;
    else state.stats.llmFallback = (state.stats.llmFallback ?? 0) + 1;

    return {
      tag,
      eventId,
      status: result?.status ?? null,
      distilledBy,
      confidence,
      sourceEventIds,
      fallbackReason,
      errorCode: failure?.code ?? null,
    };
  }

  /**
   * Run one offline Dream pass. LLM calls are strictly serial (one group at a
   * time) and the whole run is single-flight: a concurrent call is refused, not
   * queued, so a slow provider can never exhaust connections or pile up work.
   */
  async run({ now = this.clock.now(), fetchImpl = null, logger = undefined } = {}) {
    if (this._running) return { status: 'skipped', reason: 'dream-in-flight', now };
    this._running = true;
    const effectiveLogger = logger ?? this.logger;
    const previousFetch = this.fetchImpl;
    if (fetchImpl) this.fetchImpl = fetchImpl;
    try {
      const config = this.config();
      const groups = this.collectGroups(config);
      const report = {
        status: 'ok',
        now,
        groups: groups.length,
        merged: 0,
        llmSuccess: 0,
        llmFallback: 0,
        circuit: this._circuitView(),
        results: [],
        fallbacks: [],
      };
      for (const group of groups.slice(0, config.maxGroupsPerRun)) {
        const result = await this._distillGroup(group, { config, now, logger: effectiveLogger });
        report.results.push(result);
        if (result.eventId) report.merged += 1;
        if (result.distilledBy === 'llm') report.llmSuccess += 1;
        else report.llmFallback += 1;
        if (result.fallbackReason) {
          report.fallbacks.push({ tag: result.tag, reason: result.fallbackReason, code: DREAM_FALLBACK_CODE });
        }
      }
      const state = this._load();
      state.stats.runs = (state.stats.runs ?? 0) + 1;
      state.stats.lastRunAt = now;
      this._persist();
      report.circuit = this._circuitView();
      if (report.merged === 0) report.status = 'idle';
      return report;
    } finally {
      this.fetchImpl = previousFetch;
      this._running = false;
    }
  }
}

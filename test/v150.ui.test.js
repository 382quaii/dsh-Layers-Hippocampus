/**
 * v1.5.0 UI + HTTP surface contract.
 *
 * Covers the client half (bundle contract, pure helpers, screen-source rules) and
 * the transfer route (validation, delegation, error mapping).
 *
 * The client is NOT rendered: Node has no DOM here, and the real Host slot tree
 * cannot be mounted. What CAN be locked without a browser is exactly what matters
 * for activation safety: the module hands a factory to the loader, the factory
 * survives a missing React, apply registers through ctx.slots.inject, and every
 * decision that would otherwise live in an untestable render path is a pure
 * exported helper.
 *
 * WHY the no-timer search rule is asserted on source text: the trigger is the
 * Host's native `Enter` keydown. A cached delay (a timer) would race the Host —
 * the query could commit after a newer keystroke, or re-layout mid-typing. There
 * is no clean way to prove "no timer" from a helper, so the component slice and
 * the whole bundle are checked for the word and for the timer APIs.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  EDITABLE_CONFIG_KEYS,
  MEMORY_API,
  createMemoryRoutes,
  validatePatch,
} from '../src/webRoutes.js';

const CLIENT_PATH = new URL('../ui/client.js', import.meta.url);

// ---------------------------------------------------------------------------
// Bundle sandbox (mirrors test/clientSlot.test.js, deliberately no extra globals:
// a `document` access or a Node import inside the bundle would throw right here).
// ---------------------------------------------------------------------------

function fakeReact(renders = []) {
  return {
    createElement(type, props, ...children) {
      const element = { type, props: props ?? {}, children };
      renders.push(element);
      return element;
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useEffect() {},
    useRef(value) {
      return { current: value };
    },
  };
}

function loadBundle({ withLoader = true, react = true, fetchImpl } = {}) {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  const captured = {};
  const window = withLoader
    ? {
        __ModuleLoader__: {
          load(entry) {
            captured.id = entry.id;
            captured.factory = entry.factory;
          },
        },
      }
    : {};
  const fakeFetch = fetchImpl ?? (() => Promise.reject(new Error('offline')));
  const run = new Function('window', 'document', 'fetch', 'console', '"use strict";\n' + source);
  const warnings = [];
  const consoleStub = {
    warn: (...args) => warnings.push(args.join(' ')),
    error: (...args) => warnings.push(args.join(' ')),
  };
  run(window, undefined, fakeFetch, consoleStub);
  return {
    source,
    captured,
    warnings,
    makeModule: (requireImpl) =>
      captured.factory(
        requireImpl ??
          ((name) => {
            if (name === 'react' && react) return fakeReact();
            throw new Error(`unexpected module: ${name}`);
          }),
      ),
  };
}

function strictSlots() {
  const registrations = [];
  const injected = [];
  let activeScope = null;
  return {
    registrations,
    injected,
    slots: {
      inject(name, callback) {
        activeScope = name;
        injected.push(name);
        try {
          return callback();
        } finally {
          activeScope = null;
        }
      },
      register(options, component) {
        if (activeScope !== options.name) {
          throw new Error(`slot '${options.name}' registered outside its inject scope`);
        }
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Bundle activation + exported helpers.
// ---------------------------------------------------------------------------

test('v1.5.0 bundle still activates: one factory, inject slots, three registrations', () => {
  const { captured } = loadBundle();
  assert.equal(captured.id, 'dsh-layers-hippocampus');
  assert.equal(typeof captured.factory, 'function');

  const module = loadBundle().makeModule();
  assert.deepEqual(module.inject, ['slots']);
  for (const name of ['statusBarText', 'filterGraphByQuery', 'nextSpaceAfterTransfer']) {
    assert.equal(typeof module[name], 'function', `${name} must be exported for contract tests`);
  }

  const host = strictSlots();
  assert.doesNotThrow(() => module.apply({ slots: host.slots }));
  assert.deepEqual(host.injected, ['sidebar.panellist', 'main', 'settings.section']);
  assert.equal(host.registrations.length, 3);
});

test('the factory stays inert when react is missing', () => {
  const { makeModule } = loadBundle();
  const module = makeModule(() => {
    throw new Error('no module table entry for react');
  });
  assert.deepEqual(module.inject, []);
  assert.doesNotThrow(() => module.apply({}));
});

test('statusBarText: native, layered and handoff variants, null-safe', () => {
  const { makeModule } = loadBundle();
  const { statusBarText } = makeModule();

  assert.equal(
    statusBarText({ mode: 'native', tokens: 1000, nativeTokenLimit: 8000, threshold: 0.85, remainingTokens: 5800 }),
    '[当前: 原生模式 | 剩余 5800 Tokens 触发交接]',
  );
  assert.equal(
    statusBarText({ mode: 'layered', tokens: 7000, nativeTokenLimit: 8000, threshold: 0.85, remainingTokens: 100 }),
    '[当前: 分层折叠 | 剩余 100 Tokens 触发交接]',
  );
  // No remainingTokens -> nativeTokenLimit * threshold - tokens.
  assert.equal(
    statusBarText({ mode: 'native', tokens: 3000, nativeTokenLimit: 8000, threshold: 0.85 }),
    '[当前: 原生模式 | 剩余 3800 Tokens 触发交接]',
  );
  // Rounding and clamping.
  assert.match(statusBarText({ mode: 'native', remainingTokens: 42.6 }), /剩余 43 Tokens/);
  assert.match(statusBarText({ mode: 'native', tokens: 9000, nativeTokenLimit: 8000, threshold: 0.85 }), /剩余 0 Tokens/);
  // Handoff wins over any mode.
  assert.equal(statusBarText({ mode: 'layered', handoffActive: true }), '[当前: 已交接 | 摘要已存为 L1.5]');
  assert.equal(statusBarText({ mode: 'native', rolloverActive: true }), '[当前: 已交接 | 摘要已存为 L1.5]');
  // Null-safe: nothing must blank the status bar.
  assert.equal(statusBarText(null), '[当前: 原生模式 | 剩余 0 Tokens 触发交接]');
  assert.equal(statusBarText(undefined), '[当前: 原生模式 | 剩余 0 Tokens 触发交接]');
});

test('filterGraphByQuery: matches label/path, keeps only edges with both endpoints', () => {
  const { makeModule } = loadBundle();
  const { filterGraphByQuery } = makeModule();

  const graph = {
    nodes: [
      { id: 'n1', label: 'frontend', path: 'tech/frontend' },
      { id: 'n2', label: 'backend', path: 'tech/backend' },
      { id: 'n3', label: 'design', path: 'product/design' },
    ],
    edges: [
      { source: 'n1', target: 'n2' },
      { source: 'n2', target: 'n3' },
      { source: 'n1', target: 'n3' },
    ],
    nodeCount: 3,
    edgeCount: 3,
    generatedAt: 7,
  };

  // Empty query: the very same arrays, so the frozen layout is not invalidated.
  const unchanged = filterGraphByQuery(graph, '   ');
  assert.equal(unchanged.nodes, graph.nodes);
  assert.equal(unchanged.edges, graph.edges);
  assert.equal(unchanged.totalEdges, 3);

  // Case-insensitive label match.
  const front = filterGraphByQuery(graph, 'FRONT');
  assert.deepEqual(front.nodes.map((node) => node.id), ['n1']);
  assert.deepEqual(front.edges, []);
  assert.equal(front.totalEdges, 0);

  // Path match keeps both tech nodes and only their mutual edge.
  const tech = filterGraphByQuery(graph, 'tech');
  assert.deepEqual(tech.nodes.map((node) => node.id), ['n1', 'n2']);
  assert.deepEqual(tech.edges, [{ source: 'n1', target: 'n2' }]);
  assert.equal(tech.nodeCount, 2);
  assert.equal(tech.edgeCount, 1);
  assert.equal(tech.generatedAt, 7, 'projection metadata survives');

  // Id match is honoured too.
  assert.deepEqual(filterGraphByQuery(graph, 'n3').nodes.map((node) => node.id), ['n3']);

  // Null/undefined graph must never throw.
  assert.deepEqual(filterGraphByQuery(null, 'x'), { nodes: [], edges: [], totalEdges: 0 });
  assert.deepEqual(filterGraphByQuery(undefined, 'x'), { nodes: [], edges: [], totalEdges: 0 });
  assert.deepEqual(filterGraphByQuery(null, ''), { nodes: [], edges: [], totalEdges: 0 });
  // Nodes without an edges array: still filtered, never a crash.
  assert.deepEqual(filterGraphByQuery({ nodes: [{ id: 'a', label: 'alpha' }] }, 'alp').edges, []);
});

test('filterGraphByQuery: every returned edge has both endpoints in the returned nodes', () => {
  const { makeModule } = loadBundle();
  const { filterGraphByQuery } = makeModule();
  const graph = {
    nodes: [
      { id: 'a', label: 'alpha' },
      { id: 'b', label: 'beta' },
      { id: 'c', label: 'alpha-2' },
    ],
    edges: [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
      { source: 'b', target: 'c' },
    ],
  };
  const filtered = filterGraphByQuery(graph, 'alpha');
  const ids = new Set(filtered.nodes.map((node) => node.id));
  for (const edge of filtered.edges) {
    assert.ok(ids.has(edge.source) && ids.has(edge.target), 'no dangling edge survives');
  }
  assert.deepEqual(filtered.nodes.map((node) => node.id), ['a', 'c']);
  assert.deepEqual(filtered.edges, [{ source: 'a', target: 'c' }]);
});

test('nextSpaceAfterTransfer: soft follow only when explicitly on and the transfer succeeded', () => {
  const { makeModule } = loadBundle();
  const { nextSpaceAfterTransfer } = makeModule();

  assert.equal(nextSpaceAfterTransfer({ autoSpaceFollow: true, ok: true, currentSpace: 'default', targetSpaceId: 'work' }), 'work');
  assert.equal(nextSpaceAfterTransfer({ autoSpaceFollow: false, ok: true, currentSpace: 'default', targetSpaceId: 'work' }), 'default');
  assert.equal(nextSpaceAfterTransfer({ autoSpaceFollow: true, ok: false, currentSpace: 'default', targetSpaceId: 'work' }), 'default');
  assert.equal(nextSpaceAfterTransfer({ autoSpaceFollow: true, ok: true, currentSpace: 'default', targetSpaceId: '   ' }), 'default');
  assert.equal(nextSpaceAfterTransfer({ autoSpaceFollow: true, ok: true, currentSpace: 'default', targetSpaceId: null }), 'default');
  // Only `true` follows; a truthy non-boolean is not consent.
  assert.equal(nextSpaceAfterTransfer({ autoSpaceFollow: 1, ok: true, currentSpace: 'default', targetSpaceId: 'work' }), 'default');
  assert.equal(nextSpaceAfterTransfer(null), undefined);
});

// ---------------------------------------------------------------------------
// 2. Screen-source rules (strings + absence of timer APIs in the search box).
// ---------------------------------------------------------------------------

test('source carries every v1.5.0 UI marker', () => {
  const { source } = loadBundle();
  for (const marker of [
    // status bar variants
    '[当前: 原生模式 | 剩余',
    '[当前: 分层折叠',
    '[当前: 已交接',
    // footer promise
    '本插件不能保证一个会话永生不死，只能保证人格不死。',
    // config keys surfaced by the settings form
    'context.autoSpaceFollow',
    'context.autoRolloverEnabled',
    'context.autoRolloverThreshold',
    'context.nativeTokenLimit',
    'index.maxPostingsPerTag',
    // transfer UI
    '复制',
    '剪切',
    '二次确认',
    'event_ids',
    'target_space_id',
    'transfer_mode',
    '/api/hippocampus/transfer',
    // native Enter search
    'onKeyDown',
    "key === 'Enter'",
    // section title + status bar wiring
    '空间与会话交接（纯物理层）',
    'statusBarText(session)',
    'panel.spaces',
  ]) {
    assert.ok(source.includes(marker), `ui/client.js must contain ${marker}`);
  }
});

test('the tag search uses native Enter and contains NO timer (the no-delay rule)', () => {
  const { source } = loadBundle();
  // The word itself must never creep back in: the only trigger is a keydown.
  assert.ok(!source.includes('debounce'), 'no delay/caching word in the search path');

  const start = source.indexOf('function TagSearch');
  const end = source.indexOf('function KnowledgeGraph');
  assert.ok(start > 0, 'TagSearch component exists');
  assert.ok(end > start, 'KnowledgeGraph follows TagSearch');
  const slice = source.slice(start, end);

  assert.ok(slice.includes("event.key === 'Enter'"), 'Enter is the trigger');
  assert.ok(slice.includes('preventDefault'), 'Enter is consumed by the graph, not the Host form');
  assert.ok(!slice.includes('setTimeout'), 'no timer may race the Enter keydown');
  assert.ok(!slice.includes('setInterval'), 'no polling for the query either');
  assert.ok(!slice.includes('useEffect'), 'the commit happens in the keydown, not in an effect');
  // The panel only applies the committed query to the graph.
  assert.ok(source.includes('filterGraphByQuery(graphState.graph, searchQuery)'), 'graph receives the filtered projection');
});

test('the settings page orders context -> space/session -> system storage, and ends with the footer', () => {
  const { source } = loadBundle();
  const contextSection = source.indexOf("title: '上下文窗口'");
  const newSection = source.indexOf('空间与会话交接（纯物理层）');
  // Compare the RENDERED usage, not the component definition (hoisted above).
  const storageSection = source.indexOf('h(StorageMigratorUI');
  assert.ok(contextSection > 0 && storageSection > 0);
  assert.ok(newSection > contextSection && newSection < storageSection, 'new section sits after 上下文窗口');

  const saveIndex = source.indexOf('保存全部');
  const footerIndex = source.indexOf('本插件不能保证一个会话永生不死，只能保证人格不死。');
  assert.ok(footerIndex > saveIndex, 'footer comes after the save button row');
  const footerSlice = source.slice(Math.max(0, footerIndex - 400), footerIndex + 60);
  assert.ok(footerSlice.includes('fontWeight: 600'), 'the promise is bold');

  // Draft + save patch both carry the new keys.
  for (const marker of [
    "'context.autoSpaceFollow': Boolean(draft.context.autoSpaceFollow)",
    "'context.autoRolloverEnabled': Boolean(draft.context.autoRolloverEnabled)",
    "'context.autoRolloverThreshold': Number(draft.context.autoRolloverThreshold)",
    "'context.nativeTokenLimit': Number(draft.context.nativeTokenLimit)",
    "'index.maxPostingsPerTag': Number(draft.index.maxPostingsPerTag)",
    "edit('context.autoRolloverThreshold'",
    "edit('context.nativeTokenLimit'",
    "edit('index.maxPostingsPerTag'",
    'index: { ...(prev.index || {}) }',
  ]) {
    assert.ok(source.includes(marker), `settings wiring must contain ${marker}`);
  }
});

test('the transfer flow requires a second explicit confirmation before the POST can fire', () => {
  const { source } = loadBundle();
  for (const marker of [
    'function CrossSpaceTransferUI',
    '即将向 [',
    '二次确认 · 安全红线',
    '确认并授权迁移',
    '下一步',
    'setStep(2)',
    'user_approved: true',
    'requireExplicitConsentForTransfer',
    '剪切会使源空间数据进入两阶段待删队列（宽限期后可 restore），确定继续？',
  ]) {
    assert.ok(source.includes(marker), `transfer confirmation must contain ${marker}`);
  }
  // Step 2 is the only branch that can call submit(); step 1 only advances.
  const component = source.slice(source.indexOf('function CrossSpaceTransferUI'), source.indexOf('function MemoryPanel'));
  const submitCalls = component.match(/onClick: submit/g) ?? [];
  assert.equal(submitCalls.length, 1, 'the POST handler is wired to exactly one button');
  assert.ok(component.indexOf('onClick: submit') > component.indexOf('step === 1'), 'submit only renders in the second step');
});

// ---------------------------------------------------------------------------
// 3. HTTP transfer route.
// ---------------------------------------------------------------------------

function fakeRuntime(overrides = {}) {
  const calls = { transfer: [] };
  return {
    calls,
    runtime: {
      state: 'ready',
      phase: 'ready',
      async uiPayload() {
        return { ok: true, phase: 'ready', panel: {} };
      },
      async transferEvents(payload) {
        calls.transfer.push(payload);
        return {
          target: { spaceId: payload.targetSpaceId, eventIds: ['new-1', 'new-2'], tags: ['transferred:from:default'] },
          source: { spaceId: payload.sourceSpaceId ?? 'default' },
          mode: payload.transferMode,
        };
      },
      ...overrides,
    },
  };
}

function fakeRequest({ method = 'POST', url = '/', body = null } = {}) {
  const chunks = body === null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const stream = Readable.from(chunks);
  stream.method = method;
  stream.url = url;
  stream.headers = { host: '127.0.0.1' };
  return stream;
}

function fakeResponse() {
  const state = { status: 0, headers: null, text: '' };
  return {
    state,
    json: () => JSON.parse(state.text),
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers ?? null;
      return this;
    },
    end(text = '') {
      state.text = text;
      return this;
    },
  };
}

async function call(routes, path, request) {
  const route = routes.find((candidate) => candidate.path === path);
  assert.ok(route, `route ${path} is registered`);
  const res = fakeResponse();
  await route.handler(request, res);
  return res;
}

test('webRoutes: the v1.5.0 config keys are whitelisted and nest under their groups', () => {
  for (const key of [
    'context.autoSpaceFollow',
    'context.autoRolloverEnabled',
    'context.autoRolloverThreshold',
    'context.nativeTokenLimit',
    'context.requireExplicitConsentForTransfer',
    'index.maxPostingsPerTag',
  ]) {
    assert.ok(EDITABLE_CONFIG_KEYS.includes(key), `${key} must be editable over HTTP`);
  }
  assert.deepEqual(
    validatePatch({
      'context.autoSpaceFollow': true,
      'context.autoRolloverEnabled': false,
      'context.autoRolloverThreshold': 0.85,
      'context.nativeTokenLimit': 8000,
      'context.requireExplicitConsentForTransfer': true,
      'index.maxPostingsPerTag': 500,
    }),
    {
      context: {
        autoSpaceFollow: true,
        autoRolloverEnabled: false,
        autoRolloverThreshold: 0.85,
        nativeTokenLimit: 8000,
        requireExplicitConsentForTransfer: true,
      },
      index: { maxPostingsPerTag: 500 },
    },
  );
  // A key outside the new groups still fails loudly.
  assert.throws(() => validatePatch({ 'index.unknown': 1 }), /not editable/);
});

test('webRoutes: exactly eight exact routes, transfer/memories/spaces/session-reset included', () => {
  const { runtime } = fakeRuntime();
  const routes = createMemoryRoutes({ runtime });
  assert.equal(routes.length, 8);
  assert.deepEqual(routes.map((route) => route.path), [
    MEMORY_API.stats,
    MEMORY_API.config,
    MEMORY_API.graph,
    MEMORY_API.retry,
    MEMORY_API.transfer,
    MEMORY_API.memories,
    MEMORY_API.spaces,
    MEMORY_API.sessionReset,
  ]);
  assert.deepEqual(routes.map((route) => route.kind), ['exact', 'exact', 'exact', 'exact', 'exact', 'exact', 'exact', 'exact']);
  assert.equal(MEMORY_API.transfer, '/api/hippocampus/transfer');
  assert.equal(MEMORY_API.memories, '/api/hippocampus/memories');
  assert.equal(MEMORY_API.spaces, '/api/hippocampus/spaces');
});

test('webRoutes: POST transfer delegates to runtime.transferEvents and returns its result', async () => {
  const { runtime, calls } = fakeRuntime();
  const routes = createMemoryRoutes({ runtime });
  const res = await call(
    routes,
    MEMORY_API.transfer,
    fakeRequest({
      method: 'POST',
      body: {
        event_ids: ['e1', 'e2'],
        target_space_id: 'work',
        transfer_mode: 'move',
        source_space_id: 'default',
        user_approved: true,
      },
    }),
  );

  assert.equal(res.state.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.target.eventIds, ['new-1', 'new-2']);
  assert.deepEqual(body.target.tags, ['transferred:from:default']);
  assert.equal(body.state, 'ready');
  assert.equal(calls.transfer.length, 1);
  assert.deepEqual(calls.transfer[0], {
    eventIds: ['e1', 'e2'],
    targetSpaceId: 'work',
    transferMode: 'move',
    sourceSpaceId: 'default',
    // The HTTP route IS the human channel: the browser request marks consent
    // itself, so the engine's gate lets it through (v1.5.1 security patch).
    userApproved: true,
  });
});

test('webRoutes: transfer defaults to copy and normalises ids', async () => {
  const { runtime, calls } = fakeRuntime();
  const routes = createMemoryRoutes({ runtime });
  const res = await call(
    routes,
    MEMORY_API.transfer,
    fakeRequest({ method: 'POST', body: { patch: { event_ids: [' e1 ', 'e2'], target_space_id: ' work ', user_approved: true } } }),
  );
  assert.equal(res.state.status, 200);
  assert.deepEqual(calls.transfer[0].eventIds, ['e1', 'e2']);
  assert.equal(calls.transfer[0].targetSpaceId, 'work');
  assert.equal(calls.transfer[0].transferMode, 'copy');
  assert.equal(calls.transfer[0].userApproved, true, 'explicit user_approved is forwarded by the route');
});

test('webRoutes: invalid transfer bodies answer 400 MEM_E_INVALID_INPUT without touching the engine', async () => {
  for (const body of [
    {},
    { event_ids: [], target_space_id: 'work' },
    { event_ids: ['e1'], target_space_id: '' },
    { event_ids: ['e1', 42], target_space_id: 'work' },
    { event_ids: ['e1'], target_space_id: 'work', transfer_mode: 'destroy' },
    { event_ids: ['e1'], target_space_id: 'work', source_space_id: 7 },
    '{not json',
  ]) {
    const { runtime, calls } = fakeRuntime();
    const routes = createMemoryRoutes({ runtime });
    const res = await call(routes, MEMORY_API.transfer, fakeRequest({ method: 'POST', body }));
    assert.equal(res.state.status, 400, `body ${JSON.stringify(body)} must be rejected`);
    assert.equal(res.json().ok, false);
    assert.equal(res.json().error.code, 'MEM_E_INVALID_INPUT');
    assert.equal(res.json().state, 'ready');
    assert.equal(calls.transfer.length, 0, 'validation happens before the engine call');
  }
});

test('webRoutes: engine failures map to 400 with their own code and no secret text', async () => {
  const blocked = new Error('payload matched a privacy pattern');
  blocked.code = 'MEM_E_PRIVACY_BLOCKED';
  blocked.details = { ids: ['e1'], categories: ['phone'] };
  const { runtime } = fakeRuntime({
    async transferEvents() {
      throw blocked;
    },
  });
  const routes = createMemoryRoutes({ runtime });
  const res = await call(
    routes,
    MEMORY_API.transfer,
    fakeRequest({ method: 'POST', body: { event_ids: ['e1'], target_space_id: 'work', user_approved: true } }),
  );
  assert.equal(res.state.status, 400);
  assert.equal(res.json().ok, false);
  assert.equal(res.json().error.code, 'MEM_E_PRIVACY_BLOCKED');
  assert.deepEqual(res.json().error.details, { ids: ['e1'], categories: ['phone'] });
});

test('webRoutes: GET transfer answers 405 with the state envelope', async () => {
  const { runtime } = fakeRuntime();
  const routes = createMemoryRoutes({ runtime });
  const res = await call(routes, MEMORY_API.transfer, fakeRequest({ method: 'GET' }));
  assert.equal(res.state.status, 405);
  assert.equal(res.json().ok, false);
  assert.equal(res.json().state, 'ready');
  assert.equal(res.json().error.code, 'MEM_E_INVALID_INPUT');
});

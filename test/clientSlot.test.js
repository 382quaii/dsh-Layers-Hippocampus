/**
 * Client half: module-loader contract, slot registration, and — most important —
 * the guarantee that a UI defect can never fail plugin activation.
 *
 * The harness aborts the whole Web boot when a client entry does not activate
 * ("web boot: N entries did not activate"), so every failure path here must be
 * swallowed by the bundle itself. These tests run the real bundle text in a
 * sandbox with a fake module loader, fake React and fake slots.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const CLIENT_PATH = new URL('../ui/client.js', import.meta.url);
const HOST_PATH = new URL('../index.js', import.meta.url);
const MANIFEST_PATH = new URL('../package.json', import.meta.url);

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

/** Evaluate the bundle with a capturing loader; returns the captured factory. */
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
  // No other globals are provided: a Node import or a document access would throw here.
  const run = new Function('window', 'document', 'fetch', 'console', '"use strict";\n' + source);
  const warnings = [];
  const consoleStub = {
    warn: (...args) => warnings.push(args.join(' ')),
    error: (...args) => warnings.push(args.join(' ')),
  };
  run(window, undefined, fakeFetch, consoleStub);
  return {
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
        // Mirrors the real service: a registration outside its inject scope is
        // exactly the mistake that made the entry fail to activate.
        if (activeScope !== options.name) {
          throw new Error(`slot '${options.name}' registered outside its inject scope`);
        }
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
}

test('the bundle registers one factory under the package id', () => {
  const { captured } = loadBundle();
  assert.equal(captured.id, 'dsh-layers-hippocampus');
  assert.equal(typeof captured.factory, 'function');
});

test('a page without the module loader never throws', () => {
  assert.doesNotThrow(() => loadBundle({ withLoader: false }));
});

test('the factory survives a missing react module', () => {
  const { makeModule } = loadBundle();
  const module = makeModule((name) => {
    throw new Error(`no module table entry for ${name}`);
  });
  assert.deepEqual(module.inject, []);
  assert.doesNotThrow(() => module.apply({}));
});

test('apply registers the three slots through inject, never raw register', () => {
  const { makeModule } = loadBundle();
  const module = makeModule();
  assert.deepEqual(module.inject, ['slots']);

  const host = strictSlots();
  assert.doesNotThrow(() => module.apply({ slots: host.slots }));
  assert.deepEqual(host.injected, ['sidebar.panellist', 'main', 'settings.section']);

  const byName = Object.fromEntries(host.registrations.map((entry) => [entry.options.name, entry.options]));
  assert.deepEqual(byName['sidebar.panellist'], { name: 'sidebar.panellist', id: 'hippocampus-panel', order: 60, label: '海马体记忆' });
  assert.deepEqual(byName.main, { name: 'main', key: 'hippocampus-panel' });
  assert.deepEqual(byName['settings.section'], { name: 'settings.section', id: 'hippocampus-settings', order: 25, label: '海马体记忆' });
  for (const entry of host.registrations) assert.equal(typeof entry.component, 'function');
});

test('apply is inert without a slots service', () => {
  const { makeModule } = loadBundle();
  const module = makeModule();
  for (const ctx of [{}, { slots: null }, { slots: {} }, undefined]) {
    assert.doesNotThrow(() => module.apply(ctx));
  }
});

test('a throwing register is contained and the other slots still mount', () => {
  const { makeModule, warnings } = loadBundle();
  const module = makeModule();
  const registered = [];
  module.apply({
    slots: {
      inject(_name, callback) {
        return callback();
      },
      register(options) {
        if (options.name === 'main') throw new Error('boom');
        registered.push(options.name);
        return () => {};
      },
    },
  });
  assert.deepEqual(registered, ['sidebar.panellist', 'settings.section']);
  assert.ok(warnings.some((line) => line.includes('main')), 'the failure is reported, not rethrown');
});

test('the sidebar icon renders an svg with painter props only', () => {
  const { makeModule } = loadBundle();
  const module = makeModule();
  let icon = null;
  module.apply({
    slots: {
      inject(_name, callback) {
        return callback();
      },
      register(options, component) {
        if (options.id === 'hippocampus-panel' && options.name === 'sidebar.panellist') icon = component;
        return () => {};
      },
    },
  });
  const element = icon({ size: 16, active: true });
  assert.equal(element.type, 'svg');
  assert.equal(element.props.width, 16);
});

test('the host entry stays free of React and DOM code', () => {
  const host = fs.readFileSync(HOST_PATH, 'utf8');
  assert.doesNotMatch(host, /require\(['"]react['"]\)/, 'React belongs to the client bundle only');
  assert.doesNotMatch(host, /document\./, 'no DOM access from the host half');
  assert.doesNotMatch(host, /React\.createElement/, 'no rendering in index.js');
  assert.match(host, /registerMemoryRoutes/, 'the host exposes the JSON routes instead');
});

test('the bundle talks to the hippocampus routes and sends graphMaxEdges', () => {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  for (const route of ['/api/hippocampus/stats', '/api/hippocampus/config', '/api/hippocampus/graph', '/api/hippocampus/retry']) {
    assert.ok(source.includes(route), `client must use ${route}`);
  }
  assert.ok(source.includes('graphMaxEdges'), 'the settings form must edit graphMaxEdges');
  assert.ok(source.includes('api/hippocampus/retry'), 'the failed banner needs the retry route');
});

test('the graph drags through pointer events and refs, not through setState', () => {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  for (const hook of ['onPointerDown', 'onPointerMove', 'onPointerUp', 'onPointerCancel', 'setPointerCapture', 'releasePointerCapture']) {
    assert.ok(source.includes(hook), `graph must use ${hook}`);
  }
  assert.ok(source.includes('nodeEls'), 'node handles live in a ref');
  assert.ok(source.includes('lineEls'), 'edge handles live in a ref');
  assert.ok(source.includes('requestAnimationFrame'), 'release runs a local alpha relaxation');
  const graph = source.slice(source.indexOf('function KnowledgeGraph'));
  const body = graph.slice(0, graph.indexOf('// ---- panel'));
  assert.ok(!body.includes('setState('), 'dragging must not trigger a React re-render');
});

test('settings cover every documented config key, including storageBudgetMb', () => {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  for (const key of [
    'storageBudgetMb',
    'identity.eventTimePolicy',
    'retrieval.topK',
    'maxRecallTopK',
    'maintenanceCron',
    'promptSection',
    'autoMaintainOnBoot',
    'temp.promotionWindowDays',
    'tagTree.midHalfLifeMultiplier',
    'tagTree.midGracePeriodDays',
    'tagTree.pruneBatchSize',
    'tagTree.leafDecayFloor',
    'raw.maxScanTurns',
  ]) {
    assert.ok(source.includes(key), `settings must expose ${key}`);
  }
  assert.ok(source.includes("announce('config-changed')"), 'a save must refresh the panel immediately');
});

test('the client retries on body.state, never on the HTTP status', () => {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  for (const marker of ["state === 'ready'", "'pending'", "'in_progress'", "'failed'", 'FAILED_RETRIES', 'BOOT_MAX_WAIT_MS']) {
    assert.ok(source.includes(marker), `client must branch on ${marker}`);
  }
  assert.ok(!/status === 503/.test(source), 'the UI must not special-case HTTP 503');
  assert.ok(source.includes("announce('reconnect')"), 'manual reconnect must re-arm the poll');
  assert.ok(!source.includes('BOOT_GRACE_MS'), 'the old 2-minute give-up window must be gone');
});

test('retryPolicy: a bodiless 404 keeps booting with backoff, it is not fatal', () => {
  const { makeModule } = loadBundle();
  const { retryPolicy } = makeModule();

  const first = retryPolicy({ hasJson: false, state: undefined, status: 404, miss: 0, elapsedMs: 500 });
  assert.equal(first.kind, 'pending');
  assert.equal(first.delay, 1000);
  assert.equal(first.gaveUp, undefined);

  let miss = 0;
  let delay = 0;
  for (let i = 0; i < 6; i += 1) {
    const step = retryPolicy({ hasJson: false, state: undefined, status: 404, miss, elapsedMs: 60_000 });
    miss = step.miss;
    delay = step.delay;
  }
  assert.ok(delay <= 5000, `backoff capped at 5s, got ${delay}`);

  const timedOut = retryPolicy({ hasJson: false, state: undefined, status: 404, miss: 6, elapsedMs: 10 * 60_000 });
  assert.equal(timedOut.kind, 'failed');
  assert.equal(timedOut.gaveUp, true);
  assert.equal(timedOut.error.code, 'MEM_E_BOOT_TIMEOUT');
});

test('retryPolicy: state decides, and a JSON body without state is not a death sentence', () => {
  const { makeModule } = loadBundle();
  const { retryPolicy } = makeModule();

  assert.equal(retryPolicy({ hasJson: true, state: 'ready', status: 200, miss: 5, elapsedMs: 1 }).kind, 'ready');
  assert.equal(retryPolicy({ hasJson: true, state: 'pending', status: 503, miss: 5, elapsedMs: 1 }).kind, 'pending');
  assert.equal(retryPolicy({ hasJson: true, state: 'in_progress', status: 200, miss: 5, elapsedMs: 1 }).delay, 2000);

  const firstFailed = retryPolicy({ hasJson: true, state: 'failed', status: 500, miss: 0, elapsedMs: 10 });
  assert.equal(firstFailed.kind, 'failed');
  assert.equal(firstFailed.gaveUp, false);
  const lastFailed = retryPolicy({ hasJson: true, state: 'failed', status: 500, miss: 4, elapsedMs: 10 });
  assert.equal(lastFailed.gaveUp, true);
  assert.equal(lastFailed.delay, 0);

  const legacy = retryPolicy({ hasJson: true, state: undefined, status: 200, miss: 5, elapsedMs: 5000 });
  assert.equal(legacy.kind, 'pending');
  assert.ok(legacy.delay <= 5000);
});

test('settings expose decay.halfLifeDays and activeSet.cap with the documented hints', () => {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  for (const marker of ['decay.halfLifeDays', 'activeSet.cap', '普通用户 50MB', '8000 - 12000', '调大能记住更久', '下次维护生效']) {
    assert.ok(source.includes(marker), `settings must include ${marker}`);
  }
});

test('the tag-tree knobs render as sliders with numeric boxes and hover tooltips', () => {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  // A real slider AND a number box: the slider is for exploration, the box for
  // exact values, and both feed the same draft field.
  assert.ok(source.includes("type: 'range'"), 'the L1.5 knobs are sliders');
  assert.ok(source.includes("type: 'number'"), 'the slider keeps an exact numeric box');
  // Tooltip: the label carries the scenario hint as a native title.
  assert.ok(source.includes("title: props.hint"), 'each control exposes its hint as a tooltip');
  for (const marker of [
    'mid 半衰期', 'mid 宽限期', '剪枝批大小', '衰减地板',
    '幽灵', '模糊记忆', '下一次维护生效',
  ]) {
    assert.ok(source.includes(marker), `tag-tree settings must explain ${marker}`);
  }
  assert.ok(source.includes("edit('tagTree.midHalfLifeMultiplier'"), 'the multiplier is wired to the draft');
  assert.ok(source.includes("'tagTree.midHalfLifeMultiplier': Number(draft.tagTree.midHalfLifeMultiplier)"), 'the save patch carries the key');
});

test('the graph renders ghost nodes and toggles active/history with a CSS fade', () => {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  for (const marker of [
    'ghostNodes', 'ghostEdges', 'ghostRoot', 'ghost: true',
    '仅活跃', '历史全貌',
    'strokeDasharray', 'setHistory',
    "transition: 'opacity 420ms ease'",
    'props.ghosts',
    'body.tagTree',
  ]) {
    assert.ok(source.includes(marker), `graph must include ${marker}`);
  }
  // The fade must not re-run the layout: history is not part of the layout key.
  const graph = source.slice(source.indexOf('function KnowledgeGraph'));
  const keyLine = graph.slice(graph.indexOf('const layoutKey'), graph.indexOf('const layoutKey') + 260);
  assert.ok(!keyLine.includes('history'), 'toggling history must not restart the force layout');
});

test('ghostGraphParts: a ghost hangs under its parent root as a translucent node', () => {
  const { makeModule } = loadBundle();
  const { ghostGraphParts } = makeModule();
  assert.equal(typeof ghostGraphParts, 'function');

  const parts = ghostGraphParts([
    { id: 'mid:frontend', name: 'frontend', parentId: 'root:tech', graceUntil: 1_700_000_000_000 },
    { id: 'mid:data', name: 'data', parentId: 'root:tech', graceUntil: 1_700_000_000_000 },
    { id: 'mid:solo', name: 'solo', parentId: null, graceUntil: null },
    null,
    { name: 42 },
  ]);

  assert.deepEqual(parts.rootNodes.map((root) => root.id), ['ghostroot:tech', 'ghostroot:history'], 'roots are deduped');
  assert.deepEqual(parts.nodes.map((node) => node.id), ['ghost:mid:frontend', 'ghost:mid:data', 'ghost:mid:solo']);
  assert.deepEqual(parts.nodes[0], {
    id: 'ghost:mid:frontend',
    label: 'frontend',
    ghost: true,
    weight: 0.2,
    events: 0,
    graceUntil: 1_700_000_000_000,
    path: 'tech/frontend',
  });
  assert.deepEqual(parts.edges, [
    { source: 'ghostroot:tech', target: 'ghost:mid:frontend', weight: 0.5, ghost: true },
    { source: 'ghostroot:tech', target: 'ghost:mid:data', weight: 0.5, ghost: true },
    { source: 'ghostroot:history', target: 'ghost:mid:solo', weight: 0.5, ghost: true },
  ]);
  assert.deepEqual(ghostGraphParts(undefined), { rootNodes: [], nodes: [], edges: [] }, 'a missing list is empty, not a crash');
});

test('the manifest points ./client at a real file and declares a web client', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  assert.equal(manifest.exports['./client'], './ui/client.js');
  assert.equal(manifest.exports['./package.json'], './package.json', 'client-modules resolves the manifest through exports');
  assert.ok(fs.existsSync(new URL('../ui/client.js', import.meta.url)));

  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, undefined, 'the UI must not be boot-critical');
  assert.equal(manifest.name, 'dsh-layers-hippocampus');
  assert.equal(manifest.version, '1.7.0');
  assert.ok(manifest.dsh.client.inject === undefined || Array.isArray(manifest.dsh.client.inject));
});

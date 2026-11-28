import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const CLIENT_PATH = new URL('../ui/client.js', import.meta.url);

function fakeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
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

/** Evaluate the bundle with a capturing loader (same harness as clientSlot.test.js). */
function loadClient() {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  const captured = {};
  const window = {
    __ModuleLoader__: {
      load(entry) {
        captured.id = entry.id;
        captured.factory = entry.factory;
      },
    },
  };
  const run = new Function('window', 'document', 'fetch', 'console', '"use strict";\n' + source);
  const consoleStub = { warn() {}, error() {}, log() {} };
  run(window, undefined, () => Promise.reject(new Error('offline')), consoleStub);
  return captured;
}

const captured = loadClient();
const module = captured.factory((name) => {
  if (name === 'react') return fakeReact();
  throw new Error(`unexpected module: ${name}`);
});
const geometry = module.graphGeometry;

test('graph geometry is exported for real (not just source text)', () => {
  assert.ok(geometry, 'module.graphGeometry must exist');
  for (const name of ['computeLayout', 'separateOverlaps', 'layoutWorld', 'fitView', 'computeRadius']) {
    assert.equal(typeof geometry[name], 'function', `graphGeometry.${name} must be a function`);
  }
});

test('layout world grows with the node count instead of cramming a fixed box', () => {
  const small = geometry.layoutWorld({ width: 320, height: 320, count: 6 });
  const big = geometry.layoutWorld({ width: 320, height: 320, count: 90 });
  assert.ok(small.width >= 320 && small.height >= 320, 'the world is never smaller than the viewport');
  assert.ok(big.width > small.width || big.height > small.height, 'more nodes must get more room');
  assert.ok(big.factor <= 3, 'the world growth is bounded');
});

test('computeLayout keeps every node inside the world and spreads them out', () => {
  const nodes = Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, weight: 25 - i, events: 25 - i }));
  const edges = nodes.slice(1).map((node, i) => ({ source: `n${i}`, target: node.id, weight: 1 + (i % 3) }));
  const world = geometry.layoutWorld({ width: 640, height: 352, count: nodes.length });
  const positions = geometry.computeLayout(nodes, edges, world.width, world.height, 25);

  assert.equal(positions.length, nodes.length);
  for (const position of positions) {
    assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y), 'coordinates must be finite');
    assert.ok(position.x >= 0 && position.x <= world.width, `x ${position.x} outside world ${world.width}`);
    assert.ok(position.y >= 0 && position.y <= world.height, `y ${position.y} outside world ${world.height}`);
    assert.ok(position.r >= 4 && position.r <= 14, 'radius is clamped to the readable band');
  }

  // The old model collapsed everything onto the centre; a healthy layout uses
  // a real fraction of the world in BOTH axes.
  const xs = positions.map((position) => position.x);
  const ys = positions.map((position) => position.y);
  const spreadX = Math.max(...xs) - Math.min(...xs);
  const spreadY = Math.max(...ys) - Math.min(...ys);
  assert.ok(spreadX > world.width * 0.3, `x spread ${spreadX} is too tight for ${world.width}`);
  assert.ok(spreadY > world.height * 0.3, `y spread ${spreadY} is too tight for ${world.height}`);
});

test('separateOverlaps guarantees label room without pushing nodes out of the world', () => {
  const positions = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, x: 60 + (i % 3) * 2, y: 60 + Math.floor(i / 3) * 2, r: 3 + i }));
  geometry.separateOverlaps(positions, { width: 640, height: 400 });
  for (const position of positions) {
    assert.ok(position.x >= 0 && position.x <= 640, `x ${position.x} escaped the world`);
    assert.ok(position.y >= 0 && position.y <= 400, `y ${position.y} escaped the world`);
  }
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      const a = positions[i];
      const b = positions[j];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const wanted = (a.r + b.r) * 0.6; // packing against a hard boundary cannot always reach the full gap
      assert.ok(distance >= wanted, `nodes ${i}/${j} still overlap (${distance.toFixed(1)} < ${wanted.toFixed(1)})`);
    }
  }
});

test('fitView puts the whole graph inside the viewport', () => {
  const positions = [
    { id: 'a', x: 20, y: 40, r: 8 },
    { id: 'b', x: 500, y: 300, r: 6 },
    { id: 'c', x: 260, y: 120, r: 10 },
  ];
  const viewport = { width: 420, height: 300 };
  const view = geometry.fitView(positions, viewport);
  assert.ok(view.k > 0 && view.k <= 1.4, `unexpected scale ${view.k}`);
  for (const position of positions) {
    const screenX = position.x * view.k + view.x;
    const screenY = position.y * view.k + view.y;
    assert.ok(screenX >= 0 && screenX <= viewport.width, `node ${position.id} x off screen: ${screenX}`);
    assert.ok(screenY >= 0 && screenY <= viewport.height, `node ${position.id} y off screen: ${screenY}`);
  }
});

test('fitView never blows a tiny graph up past the safe scale', () => {
  const view = geometry.fitView([{ id: 'a', x: 10, y: 10, r: 6 }], { width: 640, height: 352 });
  assert.ok(view.k <= 1.4, 'a single node must not be magnified into a blob');
});

test('glow colours answer for every preset and for a custom accent', () => {
  for (const preset of ['accent', 'vivid', 'warm']) {
    const colors = module.graphGeometry.glowColors({ preset });
    for (const key of ['strong', 'weak', 'capture']) {
      assert.match(colors[key], /^#[0-9a-f]{6}$/, `${preset}.${key} must be a hex colour`);
    }
  }
  const custom = module.graphGeometry.glowColors({ preset: 'accent', custom: '#ff0066' });
  assert.match(custom.strong, /^#[0-9a-f]{6}$/);
  assert.notEqual(custom.strong, module.graphGeometry.glowColors({ preset: 'accent' }).strong);
});

test('the graph measures its container and lets a node leave the visible frame', () => {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  for (const marker of ['ResizeObserver', 'fitToContent', 'layoutWorld', 'GRAPH_DRAG_GUTTER', 'graphGeometry', 'useActivity', 'hp-glow-strong', 'api/hippocampus/activity']) {
    assert.ok(source.includes(marker), `ui/client.js must implement ${marker}`);
  }
  assert.equal(source.includes('const width = 640;'), false, 'the fixed 640px drawing box must be gone');
  assert.equal(source.includes('Math.min(width - 24, point.x + drag.offsetX)'), false, 'drag must no longer clamp to the old box');

  // v1.7.5 regression: dragging a node must not pan the canvas. The old auto-pan
  // shifted viewRef while the pointer moved, so the node appeared to fly away.
  const start = source.indexOf('const onPointerMove = (evt) => {');
  const end = source.indexOf('const endDrag = (evt) => {');
  assert.ok(start > 0 && end > start, 'node-drag handler exists');
  const drag = source.slice(start, end);
  assert.equal(drag.includes('applyView()'), false, 'node drag must not move the canvas');
  assert.equal(drag.includes('viewRef.current ='), false, 'node drag must not rewrite the view transform');
  assert.ok(drag.includes('GRAPH_DRAG_GUTTER'), 'the node may be parked outside the world');
});

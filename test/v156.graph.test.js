/**
 * v1.5.6 — knowledge-graph interaction layer.
 *
 * The graph itself cannot render in Node (no DOM), so these lock the CONTRACT the
 * bundle must ship:
 *   - Ctrl/Cmd + drag pans the canvas; plain drag still moves a node;
 *   - Ctrl/Cmd + wheel zooms around the cursor with `preventDefault` (passive:false),
 *     plain wheel leaves the page alone;
 *   - the first frozen layout is overlap-separated before painting;
 *   - double-click on blank space resets the view;
 *   - the UI advertises the interaction in a tooltip.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const SOURCE = fs.readFileSync(new URL('../ui/client.js', import.meta.url), 'utf8');

test('Ctrl-drag pans the canvas and plain drag still moves a node', () => {
  assert.ok(SOURCE.includes("evt.ctrlKey || evt.metaKey"), 'Ctrl/Cmd modifier is read');
  assert.ok(SOURCE.includes('const startPan = (evt) =>'), 'pan start exists');
  assert.ok(SOURCE.includes('onPointerDown: (evt) => {'), 'background pointerdown is wired');
  assert.ok(SOURCE.includes('evt.target === evt.currentTarget'), 'only background drag starts a pan');
  assert.ok(SOURCE.includes('const onPointerMove = (evt) => {\n          // v1.5.6: Ctrl+drag pans the canvas; plain drag moves a node.\n          if (panMove(evt)) return;'), 'pan move takes priority over node drag');
});

test('Ctrl+wheel zooms around the cursor (and plain wheel does not)', () => {
  assert.ok(SOURCE.includes("svg.addEventListener('wheel', onWheel, { passive: false })"), 'native non-passive wheel listener');
  assert.ok(SOURCE.includes('if (!(evt.ctrlKey || evt.metaKey)) return;'), 'plain wheel returns to the page');
  assert.ok(SOURCE.includes('evt.preventDefault();'), 'zoom prevents page scroll');
  assert.ok(SOURCE.includes('const zoomAt = (evt) =>'), 'zoom-at-cursor helper exists');
  assert.ok(SOURCE.includes('Math.max(0.4, Math.min(3, view.k * factor))'), 'zoom is clamped');
});

test('the initial frozen layout is overlap-separated', () => {
  assert.ok(SOURCE.includes('function separateOverlaps(positions'), 'separation pass exists');
  assert.ok(SOURCE.includes('separateOverlaps(computeLayout(allNodes, allEdges, width, height))'), 'it wraps the layout');
  assert.ok(SOURCE.includes('minDistance = 56'), 'a readable minimum distance is set');
});

test('view reset and the visible interaction hint ship with the bundle', () => {
  assert.ok(SOURCE.includes('const resetView = () =>'), 'reset helper exists');
  assert.ok(SOURCE.includes('onDoubleClick: (evt) =>'), 'double-click is wired');
  assert.ok(SOURCE.includes('Ctrl 拖拽平移 · Ctrl 滚轮缩放'), 'header hint is rendered');
  assert.ok(SOURCE.includes('Ctrl+拖拽平移 · Ctrl+滚轮缩放 · 双击空白重置视图'), 'footer hint is rendered');
  assert.ok(SOURCE.includes("h('g', { ref: groupRef, transform: 'translate(0, 0) scale(1)' }"), 'the pan/zoom group wraps the graph');
});

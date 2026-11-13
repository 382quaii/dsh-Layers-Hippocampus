/**
 * v1.6.3 — 设置页「简洁模式」契约。
 *
 * 简洁模式是纯显示层：隐藏的卡片不渲染、不参与保存，POST 只带可见键，
 * 因此文件里未显示的配置保持原值。这个测试锁住三条约定：
 *   1. 只有四块（身份 / 上下文窗口 / 存储迁移 / raw 子集）在简洁模式可见；
 *   2. 保存时 patch 被过滤为 SIMPLE_PATCH_KEYS，不会把隐藏项写回默认值；
 *   3. 校验只覆盖可见数字键，隐藏项的越界值不会阻断保存。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../ui/client.js', import.meta.url), 'utf8');
const lines = source.split(/\r?\n/);

function componentBody(name) {
  const start = lines.findIndex((line) => line.includes(`function ${name}(`));
  assert.ok(start >= 0, `${name} exists`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {6}function [A-Za-z]/.test(lines[index])) {
      end = index;
      break;
    }
  }
  assert.ok(end > start, `${name} body is bounded by the next sibling component`);
  return lines.slice(start, end).join('\n');
}

test('Section respects the hidden prop before rendering anything', () => {
  const body = componentBody('Section');
  assert.match(body, /if \(props\.hidden === true\) return null;/, 'hidden sections render nothing');
  assert.ok(
    body.indexOf('props.hidden') < body.indexOf("h(\n          'div'"),
    'the hidden check runs before the card markup is built',
  );
});

test('the mode preference is client-only and defaults to 专业模式', () => {
  assert.match(source, /const SETTINGS_MODE_KEY = 'hippocampus:settings-mode';/);
  assert.match(source, /return window\.localStorage\.getItem\(SETTINGS_MODE_KEY\) === 'simple' \? 'simple' : 'pro';/);
  assert.match(source, /function writeSettingsMode\(mode\)/);
  // It is a browser preference, never a config key: not in the editable patch list.
  assert.ok(!/'hippocampus:settings-mode',/.test(source), 'mode key is not a config patch key');
});

test('MemorySettings hides every section except the four simple-mode blocks', () => {
  const body = componentBody('MemorySettings');
  const hiddenTitles = [
    '行为',
    '工具 schema 裁剪（tools.disabled）',
    '入库自动打标（Pre-Ingest Tagging）',
    '可选能力（微内核边界）',
    '离线 Dream（LLM 蒸馏）',
    'L2 多合一蒸馏',
    '调度',
    '检索',
    '空间与会话交接（纯物理层）',
    '删除与复习',
    '存储与图谱',
    '标签树（L1.5 幽灵宽限）',
    '老化与活跃集合',
    'L2.5 趋势隔离',
  ];
  for (const title of hiddenTitles) {
    const marker = `title: '${title}'`;
    const index = body.indexOf(marker);
    assert.ok(index > 0, `section "${title}" exists`);
    // The prop object closes within the next few lines; `hidden: simpleMode` must be in it.
    assert.match(body.slice(index, index + 600), /hidden: simpleMode/, `section "${title}" is hidden in simple mode`);
  }
  // The four visible blocks must NOT be hidden as a whole.
  for (const title of ['上下文窗口', '身份']) {
    const marker = `title: '${title}'`;
    const index = body.indexOf(marker);
    assert.ok(index > 0, `visible section "${title}" exists`);
    assert.ok(!/hidden: simpleMode/.test(body.slice(index, index + 120)), `section "${title}" stays visible`);
  }
  const rawIndex = body.indexOf("title: '原始回合留存（raw）'");
  assert.ok(rawIndex > 0, 'raw section exists');
  assert.ok(!/hidden: simpleMode/.test(body.slice(rawIndex, rawIndex + 300)), 'raw card itself stays visible');
});

test('the raw card keeps exactly three controls in simple mode', () => {
  const body = componentBody('MemorySettings');
  const rawIndex = body.indexOf("title: '原始回合留存（raw）'");
  const rawCard = body.slice(rawIndex, body.indexOf("title: '删除与复习'"));
  assert.match(rawCard, /label: 'raw\.mode'/, 'raw.mode stays');
  assert.match(rawCard, /label: 'raw 总量上限（MB）'/, 'total cap stays');
  assert.match(rawCard, /label: '冷压缩引擎（raw\.compressionEngine）'/, 'engine stays');
  // The four professional-only controls are guarded by simpleMode.
  for (const label of [
    'raw 最小显著度',
    'raw 保留期（天）',
    '冷压缩阈值（raw.archiveAfterDays，天）',
    'deep_raw 扫描回合上限（raw.maxScanTurns）',
  ]) {
    const labelIndex = rawCard.indexOf(label);
    assert.ok(labelIndex > 0, `raw control "${label}" exists`);
    const previous = rawCard.slice(Math.max(0, labelIndex - 500), labelIndex);
    assert.match(previous, /simpleMode\s*\n?\s*\?\s*null/, `raw control "${label}" is simple-mode guarded`);
  }
});

test('simple mode filters save and validation to the visible keys', () => {
  // The whitelists live at bundle scope, outside the component.
  const patchList = source.slice(source.indexOf('const SIMPLE_PATCH_KEYS = ['));
  assert.match(patchList.slice(0, 800), /'identity\.eventTimePolicy'/);
  assert.match(patchList.slice(0, 800), /'context\.maxInjectTokens'/);
  assert.match(patchList.slice(0, 800), /'raw\.compressionEngine'/);
  assert.match(source, /const SIMPLE_NUMBER_KEYS = \['context\.maxTokens'/);
  const body = componentBody('MemorySettings');
  assert.match(body, /Object\.entries\(patch\)\.filter\(\(\[key\]\) => SIMPLE_PATCH_KEYS\.includes\(key\)\)/);
  assert.match(body, /const payloadPatch = simpleMode/, 'save builds a filtered patch');
  assert.match(body, /JSON\.stringify\(\{ patch: payloadPatch \}\)/, 'the filtered patch is what gets POSTed');
  assert.match(body, /simpleMode \? NUMBER_RULES\.filter\(\(rule\) => SIMPLE_NUMBER_KEYS\.includes\(rule\.key\)\) : NUMBER_RULES/);
  assert.match(body, /if \(!simpleMode && !String\(draft\.maintenanceCron \|\| ''\)\.trim\(\)\)/);
});

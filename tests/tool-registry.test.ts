import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTools, TOOL_REGISTRY } from '../src/ui/tool-registry.ts';
import { MODES } from '../src/ui/mode.ts';
import type { ToolId } from '../src/tools/tool.ts';

test('表のキーとツール自身の id が一致する', () => {
  // **ここが食い違うと静かに壊れる。** `Editor.registerTool` は `tool.id` で
  // 登録するので、表のキーが `copy` なのに中身が回転なら、ツールバーの
  // 複写ボタンが何も選ばない。型は `make(): Tool` としか言っていない
  for (const [id, entry] of Object.entries(TOOL_REGISTRY)) {
    assert.equal(entry.make().id, id, `${id} の欄が別のツールを作っている`);
  }
});

test('ツールバーの並びは表のキーの順', () => {
  // プロモードは今のところ全部出る。並びが表の順であることを見ている
  const ids = buildTools('pro').map((t) => t.id);
  assert.deepEqual(ids, Object.keys(TOOL_REGISTRY) as ToolId[]);
  assert.equal(new Set(ids).size, ids.length, '同じツールが二度出ている');
});

test('どのモードでも選択ツールは出る', () => {
  // 消えると `Editor.setTools` の逃げ先が無くなる
  for (const mode of MODES) {
    assert.ok(buildTools(mode).some((t) => t.id === 'select'), `${mode} に選択ツールが無い`);
  }
});

test('通常モードはプロモードの部分集合', () => {
  // **プロは通常を狭めない。** ワイヤーは字義どおりならプロから壁を外すが、
  // 代わりに入るはずの汎用ソリッドがまだ無いので、外すと空のモードになる
  const pro = new Set(buildTools('pro').map((t) => t.id));
  for (const tool of buildTools('normal')) {
    assert.ok(pro.has(tool.id), `${tool.id} が通常にだけある`);
  }
  assert.ok(buildTools('normal').length < pro.size, '通常とプロで何も変わらない');
});

test('どのモードにも属さないツールが無い', () => {
  for (const [id, entry] of Object.entries(TOOL_REGISTRY)) {
    assert.ok(entry.modes.length > 0, `${id} がどのモードにも出ない`);
  }
});

test('ショートカットが重なっていない', () => {
  // 重なると後ろのツールに切り替えられなくなる。今まで誰も見ていなかった
  const seen = new Map<string, string>();
  for (const tool of buildTools('pro')) {
    const key = tool.shortcut.toLowerCase();
    const other = seen.get(key);
    assert.equal(other, undefined, `${key} が ${other} と ${tool.id} で重なっている`);
    seen.set(key, tool.id);
  }
});

test('グリフと表示名が全部入っている', () => {
  for (const [id, entry] of Object.entries(TOOL_REGISTRY)) {
    assert.ok(entry.glyph.length > 0, `${id} のグリフが空`);
    const tool = entry.make();
    assert.ok(tool.label.length > 0, `${id} の表示名が空`);
    assert.ok(tool.cursor.length > 0, `${id} のカーソルが空`);
  }
});

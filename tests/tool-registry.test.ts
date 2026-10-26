import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTools, TOOL_REGISTRY } from '../src/ui/tool-registry.ts';
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
  const ids = buildTools().map((t) => t.id);
  assert.deepEqual(ids, Object.keys(TOOL_REGISTRY) as ToolId[]);
  assert.equal(new Set(ids).size, ids.length, '同じツールが二度出ている');
});

test('ショートカットが重なっていない', () => {
  // 重なると後ろのツールに切り替えられなくなる。今まで誰も見ていなかった
  const seen = new Map<string, string>();
  for (const tool of buildTools()) {
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShapeTool } from '../src/tools/shape.ts';

/**
 * **1 つのツールが複数のモードを持てる。** 建具が 11 種別を 2 ツール ＋
 * 「種類」セレクタで出しているのと同じ形。1 種別 1 ツールにすると
 * ツールバーが破綻する（いま 21 ツールで、空いているショートカットは 4 つ）。
 */
const selectFields = (tool: ShapeTool): { label: string; value: string }[] =>
  (tool.options?.() ?? [])
    .filter((f): f is Extract<typeof f, { kind: 'select' }> => f.kind === 'select')
    .map((f) => ({ label: f.label, value: f.value }));

test('モードが 1 つのツールは「種類」を出さない', () => {
  // 選ぶものが無いのに欄があると、使う側は「他に何かあるはず」と探すことになる
  const tool = new ShapeTool('line', 'line', '線', 'L');
  assert.equal(selectFields(tool).filter((f) => f.label === '種類').length, 0);
});

test('モードが 2 つ以上なら「種類」で切り替わる', () => {
  const tool = new ShapeTool(['line', 'point'], 'line', '線', 'L');
  const field = (tool.options?.() ?? []).find(
    (f): f is Extract<typeof f, { kind: 'select' }> => f.kind === 'select' && f.label === '種類',
  );
  assert.ok(field, '「種類」が出ていない');
  assert.equal(field.value, 'line', '先頭のモードが既定になっていない');
  assert.deepEqual(field.options.map((o) => o.value), ['line', 'point']);

  field.onChange('point');
  const after = (tool.options?.() ?? []).find(
    (f): f is Extract<typeof f, { kind: 'select' }> => f.kind === 'select' && f.label === '種類',
  );
  assert.equal(after?.value, 'point', '選んだモードに切り替わっていない');
  // モードを変えたら、前のモードのために溜めた点は捨てる
  assert.equal(tool.isActive?.() ?? false, false, 'モードを変えても点が残っている');
});

test('知らない値を渡してもモードは変わらない', () => {
  const tool = new ShapeTool(['line', 'point'], 'line', '線', 'L');
  const field = (tool.options?.() ?? []).find(
    (f): f is Extract<typeof f, { kind: 'select' }> => f.kind === 'select' && f.label === '種類',
  )!;
  field.onChange('arc');
  const after = (tool.options?.() ?? []).find(
    (f): f is Extract<typeof f, { kind: 'select' }> => f.kind === 'select' && f.label === '種類',
  );
  assert.equal(after?.value, 'line', '持っていないモードに切り替わった');
});

test('円モードと円弧モードでオプションが入れ替わる', () => {
  // 「種類」を足しても、モードごとの欄はそのまま後ろに並ぶ
  const tool = new ShapeTool('arc', 'arc', '円・弧', 'C');
  const kinds = selectFields(tool);
  assert.equal(kinds.length, 1, 'モードが 1 つなのにセレクタが 2 つある');
  assert.equal(kinds[0].value, 'circle');
});

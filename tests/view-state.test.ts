import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VIEW_LABELS, VIEW_MODES, ViewState } from '../src/ui/view-state.ts';

/** 変更の通知を数えながら使うための足場 */
function tracked(): { view: ViewState; seen: string[] } {
  const seen: string[] = [];
  const view = new ViewState((mode) => seen.push(mode));
  return { view, seen };
}

test('最初は 2D', () => {
  const { view, seen } = tracked();
  assert.equal(view.mode, '2d');
  assert.deepEqual(seen, [], '作っただけで通知してはいけない');
});

test('同じビューに切り替えても通知しない', () => {
  // App.applyView は setVisible と再描画を呼ぶ。素通しすると
  // パネルの refresh から戻ってきたクリックで毎回レイアウトを測り直す
  const { view, seen } = tracked();
  view.set('2d');
  assert.deepEqual(seen, []);
  view.set('3d');
  view.set('3d');
  assert.deepEqual(seen, ['3d']);
});

test('どのビューで 2D と 3D が見えるか', () => {
  const { view } = tracked();
  const shown = (mode: (typeof VIEW_MODES)[number]) => {
    view.set(mode);
    return [view.shows2d, view.shows3d, view.isSplit];
  };
  assert.deepEqual(shown('2d'), [true, false, false]);
  assert.deepEqual(shown('3d'), [false, true, false]);
  assert.deepEqual(shown('split'), [true, true, true], '分割では両方が見える');
});

test('F3 は 2D と 3D を往復し、分割からは 2D に戻る', () => {
  const { view } = tracked();
  view.toggle3d();
  assert.equal(view.mode, '3d');
  view.toggle3d();
  assert.equal(view.mode, '2d');

  // 分割は「3D が見えている」が「3D ビューではない」。
  // ここで 3D へ進むと、分割を出した人が 2D を失って驚く
  view.set('split');
  view.toggle3d();
  assert.equal(view.mode, '2d');
});

test('ビューの一覧と名前が揃っている', () => {
  assert.equal(VIEW_MODES.length, 3);
  assert.equal(new Set(VIEW_MODES).size, 3, '重複している');
  for (const mode of VIEW_MODES) {
    assert.ok(VIEW_LABELS[mode], `${mode} の表示名が無い`);
  }
  assert.equal(Object.keys(VIEW_LABELS).length, VIEW_MODES.length, '一覧に無い名前が残っている');
});

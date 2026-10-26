import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { vec } from '../src/core/geometry.ts';
import { sampleScene } from '../src/io/sample.ts';

/**
 * シーンの版は「中身が変わったか」だけを表す。
 *
 * 通知（`emit`）は選択や表示設定でも飛ぶので、それで派生データ——部屋の検出と
 * 3D のメッシュ——を作り直すと、**クリックしただけで全部組み直す**ことになる。
 */

function storeWithWall(): Store {
  const store = new Store();
  store.commit(() => {
    const s = store.scene;
    addWall(s, findOrCreateNode(s, vec(0, 0)), findOrCreateNode(s, vec(4000, 0)), 120);
  });
  return store;
}

test('commit すると版が上がる', () => {
  const store = new Store();
  const before = store.sceneVersion;
  store.commit(() => {
    const s = store.scene;
    addWall(s, findOrCreateNode(s, vec(0, 0)), findOrCreateNode(s, vec(1000, 0)), 120);
  });
  assert.ok(store.sceneVersion > before, '版が上がっていない');
});

test('選択を変えても版は上がらない', () => {
  const store = storeWithWall();
  const wallId = Object.keys(store.scene.walls)[0];
  const before = store.sceneVersion;

  store.setSelection([{ type: 'wall', id: wallId }]);
  store.toggleSelection({ type: 'wall', id: wallId });
  store.clearSelection();

  assert.equal(store.sceneVersion, before, '選択で派生データが作り直される');
});

test('表示設定を変えても版は上がらない', () => {
  const store = storeWithWall();
  const before = store.sceneVersion;
  store.update(() => void (store.settings.showGrid = !store.settings.showGrid));
  assert.equal(store.sceneVersion, before);
});

test('選択を変えても通知は飛ぶ', () => {
  // 版が上がらないことと、画面が更新されないことは別。
  // インスペクタは選択で描き直す必要がある
  const store = storeWithWall();
  let notified = 0;
  store.subscribe(() => void (notified += 1));
  store.setSelection([{ type: 'wall', id: Object.keys(store.scene.walls)[0] }]);
  store.clearSelection();
  assert.equal(notified, 2, '通知が飛んでいない');
});

test('undo と redo で版が上がる', () => {
  // シーンが丸ごと差し替わるので、派生データは必ず作り直す必要がある
  const store = storeWithWall();
  const after = store.sceneVersion;

  store.undo();
  assert.ok(store.sceneVersion > after, 'undo で版が上がっていない');
  const undone = store.sceneVersion;

  store.redo();
  assert.ok(store.sceneVersion > undone, 'redo で版が上がっていない');
});

test('版は単調増加で、undo しても戻らない', () => {
  // 版をシーンの中身から作ると undo で前の値に戻り、キャッシュが腐る
  const store = storeWithWall();
  const seen = [store.sceneVersion];
  store.undo();
  seen.push(store.sceneVersion);
  store.redo();
  seen.push(store.sceneVersion);
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] > seen[i - 1], `版が戻った: ${seen.join(' → ')}`);
  }
});

test('シーンを差し替えると版が上がる', () => {
  const store = new Store();
  const before = store.sceneVersion;
  store.replaceScene(sampleScene());
  assert.ok(store.sceneVersion > before);
});

test('touchScene は直に書き換えたあとの通知になる', () => {
  // ドラッグの途中。commit を挟まずにシーンが変わる
  const store = storeWithWall();
  const before = store.sceneVersion;
  const node = Object.values(store.scene.nodes)[0];
  node.x += 100;
  store.touchScene();
  assert.ok(store.sceneVersion > before);
});

test('commit を取り消したときは版が上がらない', () => {
  // fn が false を返すとシーンは巻き戻る。中身が変わっていないので版も動かない
  const store = storeWithWall();
  const before = store.sceneVersion;
  store.commit(() => false);
  assert.equal(store.sceneVersion, before, '取り消したのに版が上がった');
});

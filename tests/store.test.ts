import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.ts';
import { sampleScene } from '../src/io/sample.ts';

/**
 * `Store` そのもののテスト。**これまで 1 つも無かった。**
 * 個々の編集操作は `ops` や `transform` のテストが見ていて、`Store` は
 * その下を通るだけだったため。閲覧のみは `Store` にしか無い性質なので、ここで見る。
 */
test('閲覧のみでは図面が変わらない', () => {
  // **ここが保証。** 画面から道具を隠すのは行き止まりを減らすためで、
  // インスペクタの入力欄もドラッグもショートカットも別の経路で書きに来る
  const store = new Store();
  store.replaceScene(sampleScene(), { keepHistory: false });
  const before = JSON.stringify(store.scene);
  const version = store.sceneVersion;

  store.readOnly = true;
  store.commit(() => void (store.scene.walls[Object.keys(store.scene.walls)[0]].thickness = 999));
  assert.equal(JSON.stringify(store.scene), before, 'commit が通ってしまった');
  assert.equal(store.sceneVersion, version, '版が上がってしまった');

  store.undo();
  store.redo();
  assert.equal(JSON.stringify(store.scene), before, 'undo / redo が通ってしまった');
});

test('閲覧のみではドラッグの途中の書き換えも巻き戻る', () => {
  // `commitFrom` は「開始時のスナップショットを取り、途中は直に書き換える」形。
  // 止めるだけだと、途中まで動いた形がそのまま残る
  const store = new Store();
  store.replaceScene(sampleScene(), { keepHistory: false });
  const start = structuredClone(store.scene);
  const before = JSON.stringify(start);

  store.readOnly = true;
  const id = Object.keys(store.scene.nodes)[0];
  store.scene.nodes[id].x += 500;
  store.commitFrom(start);
  assert.equal(JSON.stringify(store.scene), before, '途中の書き換えが残っている');
});

test('閲覧のみでも表示の設定は変えられる', () => {
  // `update` は止めない。スナップやグリッドは図面の中身ではない
  const store = new Store();
  store.readOnly = true;
  store.update(() => void (store.settings.snapGrid = !store.settings.snapGrid));
  store.setSelection([]);
  assert.ok(true);
});

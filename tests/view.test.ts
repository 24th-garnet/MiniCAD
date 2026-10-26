import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activateView,
  activeView,
  captureView,
  clampOpacity,
  DEFAULT_VIEW_ID,
  viewsInOrder,
} from '../src/core/view.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { emptyScene, newId } from '../src/core/types.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { exportLossReport } from '../src/io/dxf.ts';

/** いまの状態を複製して 2 枚目の図面を作る */
function addView(scene: ReturnType<typeof emptyScene>, name: string): string {
  captureView(scene);
  const id = newId('vw');
  scene.views[id] = {
    id, name,
    scale: scene.standard.scale,
    layerStates: structuredClone(scene.views[scene.activeViewId].layerStates),
  };
  return id;
}

test('最初は図面が 1 枚で、いまの縮尺を持つ', () => {
  const scene = emptyScene();
  assert.deepEqual(Object.keys(scene.views), [DEFAULT_VIEW_ID]);
  assert.equal(activeView(scene).scale, scene.standard.scale);
});

test('図面を切り替えると画層と縮尺が入れ替わる', () => {
  const scene = emptyScene();
  const second = addView(scene, '天井伏図');

  // 2 枚目を作業中にして、画層と縮尺を変える
  assert.ok(activateView(scene, second));
  scene.layers[LAYER_IDS.furniture].visible = false;
  scene.layers[LAYER_IDS.wall].opacity = 0.3;
  scene.standard.scale = 50;
  captureView(scene);

  // 1 枚目に戻ると、元の状態が当たる
  assert.ok(activateView(scene, DEFAULT_VIEW_ID));
  assert.equal(scene.layers[LAYER_IDS.furniture].visible, true, '家具が消えたまま');
  assert.equal(scene.layers[LAYER_IDS.wall].opacity, 1, '透過が残っている');
  assert.equal(scene.standard.scale, 100, '縮尺が戻っていない');

  // もう一度 2 枚目へ
  assert.ok(activateView(scene, second));
  assert.equal(scene.layers[LAYER_IDS.furniture].visible, false);
  assert.equal(scene.layers[LAYER_IDS.wall].opacity, 0.3);
  assert.equal(scene.standard.scale, 50);
});

test('切り替える前に、いまの状態が控えられる', () => {
  // **控えないと、触ったことが切り替えで消える**
  const scene = emptyScene();
  const second = addView(scene, '躯体図');
  scene.layers[LAYER_IDS.dimension].visible = false; // 控えずに切り替える
  activateView(scene, second);
  activateView(scene, DEFAULT_VIEW_ID);
  assert.equal(scene.layers[LAYER_IDS.dimension].visible, false, '触ったことが消えた');
});

test('同じ図面への切り替えは何もしない', () => {
  const scene = emptyScene();
  scene.layers[LAYER_IDS.wall].visible = false;
  assert.equal(activateView(scene, DEFAULT_VIEW_ID), false);
  // 控えて当て直すと、layerStates を持たない画層の状態が消えうる
  assert.equal(scene.layers[LAYER_IDS.wall].visible, false);
});

test('知らない図面には切り替わらない', () => {
  const scene = emptyScene();
  assert.equal(activateView(scene, 'いない'), false);
  assert.equal(scene.activeViewId, DEFAULT_VIEW_ID);
});

test('図面が JSON の往復を生き延びる', () => {
  const scene = emptyScene();
  const second = addView(scene, '天井伏図');
  activateView(scene, second);
  scene.layers[LAYER_IDS.furniture].visible = false;
  scene.layers[LAYER_IDS.wall].opacity = 0.25;
  scene.standard.scale = 50;
  captureView(scene);

  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.equal(viewsInOrder(back).length, 2);
  assert.equal(back.activeViewId, second);
  assert.equal(back.views[second].name, '天井伏図');
  assert.equal(back.views[second].scale, 50);
  assert.equal(back.views[second].layerStates[LAYER_IDS.furniture].visible, false);
  assert.equal(back.views[second].layerStates[LAYER_IDS.wall].opacity, 0.25);
});

test('図面を持たない古いファイルは 1 枚に落ちる', () => {
  const raw = {
    format: 'minicad', version: 10, unit: 'mm',
    scene: { standard: { scale: 30 } },
  };
  const scene = deserialize(raw);
  assert.deepEqual(Object.keys(scene.views), [DEFAULT_VIEW_ID]);
  assert.equal(activeView(scene).scale, 30, 'そのときの縮尺が引き継がれていない');
});

test('知らない画層を指す欄は捨てる', () => {
  const raw = {
    format: 'minicad', version: 11, unit: 'mm',
    scene: {
      views: { v1: { name: 'X', scale: 100, layerStates: { wall: { visible: false }, いない: { visible: false } } } },
      activeViewId: 'v1',
    },
  };
  const scene = deserialize(raw);
  assert.deepEqual(Object.keys(scene.views.v1.layerStates), ['wall']);
});

test('不透明度は 0〜1 に収まる', () => {
  assert.equal(clampOpacity(1.5), 1);
  assert.equal(clampOpacity(-1), 0);
  assert.equal(clampOpacity('半分'), 1, '数でなければ不透明');
  assert.equal(clampOpacity(NaN), 1);
  assert.equal(clampOpacity(0.4), 0.4);
});

test('書き出しで落ちるものを報告する', () => {
  // **持っていないものは、持っていないと書く**
  const scene = emptyScene();
  assert.deepEqual(exportLossReport(scene), [], '何も無いのに報告が出る');

  scene.layers[LAYER_IDS.wall].opacity = 0.5;
  const faded = exportLossReport(scene);
  assert.equal(faded.length, 1);
  assert.match(faded[0], /透過を落としました/);
  assert.match(faded[0], /50%/);

  addView(scene, '2 枚目');
  const many = exportLossReport(scene);
  assert.equal(many.length, 2);
  assert.match(many[1], /図面は 2 枚/);
});

test('隠した画層の透過は報告しない', () => {
  // 見えていないものの透過が落ちても、受け取った側に違いは出ない
  const scene = emptyScene();
  scene.layers[LAYER_IDS.wall].opacity = 0.5;
  scene.layers[LAYER_IDS.wall].visible = false;
  assert.deepEqual(exportLossReport(scene), []);
});

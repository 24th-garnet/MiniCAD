import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorOf } from '../src/core/material.ts';
import { nearestAci, parseHex } from '../src/io/dxfPrimitive.ts';
import { sceneToSvg } from '../src/io/svg.ts';
import { sceneToDxf, exportLossReport } from '../src/io/dxf.ts';
import { entitiesOf } from './dxf-oracle.ts';
import { defaultSettings } from '../src/core/store.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { vec } from '../src/core/geometry.ts';
import { emptyScene, type Scene } from '../src/core/types.ts';

/**
 * 実体ごとの色（7 段）。
 *
 * **前は `attrs.color` を読んでいたのが 3D の着色だけ**で、画面にも紙にも
 * 出ていなかった。「色調整／カラーピッカー／スポイト」はここが土台になる。
 */

function sceneWithRedShape(): Scene {
  const scene = emptyScene();
  addWall(scene, findOrCreateNode(scene, vec(0, 0)), findOrCreateNode(scene, vec(4000, 0)), 120);
  scene.shapes.s = {
    id: 's', shape: 'line', a: vec(0, 1000), b: vec(3000, 1000),
    layerId: LAYER_IDS.shape, attrs: { ...defaultAttrs(), color: '#ff0000' },
  } as never;
  return scene;
}

test('色を指していなければ null（＝画層の色に従う）', () => {
  const scene = sceneWithRedShape();
  assert.equal(colorOf(scene, { type: 'shape', id: 's' }), '#ff0000');
  const wallId = Object.keys(scene.walls)[0];
  assert.equal(colorOf(scene, { type: 'wall', id: wallId }), null);
});

test('指した色が SVG に出る', () => {
  const scene = sceneWithRedShape();
  const svg = sceneToSvg(scene, detectRooms(scene), defaultSettings());
  assert.ok(svg.includes('#ff0000'), 'SVG に指した色が出ていない');
  // 色を消すと画層の色に戻る
  scene.shapes.s.attrs.color = null;
  const plain = sceneToSvg(scene, detectRooms(scene), defaultSettings());
  assert.ok(!plain.includes('#ff0000'), '色を消しても SVG に残っている');
});

test('指した色が DXF に実体の色として出る', () => {
  // R12 は任意の RGB を持てないので、基本の 9 色のうち近いものに寄せる
  const scene = sceneWithRedShape();
  const dxf = sceneToDxf(scene, detectRooms(scene), defaultSettings(), {
    escapeUnicode: false, trueDimension: true,
  });
  const lines = (entitiesOf(dxf) as { type?: string; color?: number; colorIndex?: number }[])
    .filter((e) => e.type === 'LINE');
  const tinted = lines.filter((e) => e.colorIndex === 1 || e.color === 0xff0000);
  assert.ok(tinted.length > 0, `赤い実体が DXF に出ていない（LINE ${lines.length} 本）`);
});

test('色を寄せたことを書き出しの報告に出す', () => {
  // **黙って変えない。** R12 の色表に無い色は近いものに寄せている
  const scene = sceneWithRedShape();
  assert.ok(exportLossReport(scene).some((n) => n.includes('色')), '色の報告が出ていない');
  scene.shapes.s.attrs.color = null;
  assert.ok(!exportLossReport(scene).some((n) => n.includes('色')), '色を指していないのに報告が出ている');
});

test('近い色番号に寄せる', () => {
  assert.deepEqual(parseHex('#ff0000'), [255, 0, 0]);
  assert.equal(parseHex('まっか'), null);
  assert.equal(nearestAci('#ff0000'), 1, '赤');
  assert.equal(nearestAci('#00ff00'), 3, '緑');
  assert.equal(nearestAci('#0000ff'), 5, '青');
  assert.equal(nearestAci('#101010'), 8, '暗い色は濃い灰へ');
  assert.equal(nearestAci('#d8d3c6'), 9, '薄い色は薄い灰へ');
  assert.equal(nearestAci(null), null, '色が無ければ画層に従う');
  assert.equal(nearestAci('rgb(1,2,3)'), null, '読めない色は画層に従う');
});

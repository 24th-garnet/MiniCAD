import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHAPE_GEOMETRY, shapeSnapPoints } from '../src/core/shapes.ts';
import { getLayer, LAYER_IDS } from '../src/core/layer.ts';
import { sceneToSvg } from '../src/io/svg.ts';
import { sceneToDxf } from '../src/io/dxf.ts';
import { defaultSettings } from '../src/core/store.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { dist, vec } from '../src/core/geometry.ts';
import { emptyScene, type Scene } from '../src/core/types.ts';
import { entitiesOf } from './dxf-oracle.ts';

/**
 * 2D 基準点（8 段）。**画面には出るが紙には出ない点。**
 *
 * 新しい仕組みは足していない。`LAYER_IDS.draft` は `printable: false` で、
 * SVG も DXF も印刷も `visible && printable` で見ているので、
 * **既定の画層を変えるだけ**で成り立つ。
 */

function sceneWithPoint(at = vec(1234, 5678)): Scene {
  const scene = emptyScene();
  // 図面が空だと書き出しが何も出さないので、壁を 1 本置いておく
  addWall(scene, findOrCreateNode(scene, vec(0, 0)), findOrCreateNode(scene, vec(4000, 0)), 120);
  scene.shapes.p = {
    id: 'p', shape: 'point', at,
    layerId: SHAPE_GEOMETRY.point.defaultLayer, attrs: defaultAttrs(),
  } as never;
  return scene;
}

test('基準点は印刷に出ない画層に乗る', () => {
  assert.equal(SHAPE_GEOMETRY.point.defaultLayer, LAYER_IDS.draft);
  const scene = sceneWithPoint();
  const layer = getLayer(scene.layers, LAYER_IDS.draft, LAYER_IDS.shape);
  assert.equal(layer.printable, false, '下書き画層が印刷に出る扱いになっている');
  assert.equal(layer.visible, true, '下書き画層が見えない扱いになっている');
});

test('基準点は SVG にも DXF にも出ない', () => {
  const scene = sceneWithPoint();
  const rooms = detectRooms(scene);
  const svg = sceneToSvg(scene, rooms, defaultSettings());
  const dxf = sceneToDxf(scene, rooms, defaultSettings(), { escapeUnicode: false, trueDimension: true });
  // 点の十字は 1234, 5678 のまわりに出る。座標がどこにも現れなければ出ていない
  assert.ok(!svg.includes('1234'), 'SVG に基準点が出ている');
  // **画層の表には出る**（DXF は使っている画層を全部並べる）。
  // 見るのは実体のほう——下書き画層に乗ったエンティティが 1 つも無いこと
  const onDraft = (entitiesOf(dxf) as { layer?: string }[]).filter((e) => e.layer === 'A-DRAFT');
  assert.equal(onDraft.length, 0, `DXF に基準点が ${onDraft.length} 個出ている`);
});

test('基準点はスナップで拾える', () => {
  // **印刷に出ないことと、作図で使えることは別。** 画層の `visible` と
  // `locked` しか見ていないので、下書き画層のままで拾える
  const scene = sceneWithPoint();
  const points = shapeSnapPoints(scene, scene.shapes.p);
  assert.ok(points.some((p) => dist(p.point, vec(1234, 5678)) < 1e-9), '基準点にスナップが行かない');
});

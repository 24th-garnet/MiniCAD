import { test } from 'node:test';
import assert from 'node:assert/strict';
import DxfParser from 'dxf-parser';
import { sampleScene } from '../src/io/sample.ts';
import { emptyScene } from '../src/core/types.ts';
import { createWallDimensions, dimensionGeometry, moveDimension } from '../src/core/dimension.ts';
import { addWall, findOrCreateNode, moveNodes } from '../src/core/ops.ts';
import { transformEntities } from '../src/core/transformOps.ts';
import { mirror, translation } from '../src/core/transform.ts';
import { deserialize, serialize, FILE_VERSION } from '../src/io/scene.ts';
import { sceneToDxf } from '../src/io/dxf.ts';
import { sceneToSvg } from '../src/io/svg.ts';
import { defaultSettings } from '../src/core/store.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { dist, vec } from '../src/core/geometry.ts';
import type { DimensionShape } from '../src/core/shapes.ts';

function sceneWithWall() {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const wall = addWall(scene, a, b, 100)!;
  const dim: DimensionShape = {
    id: 'd1',
    shape: 'dimension',
    layerId: LAYER_IDS.dimension,
    levelId: DEFAULT_LEVEL_ID,
    attrs: defaultAttrs(),
    a: { x: 0, y: 0, nodeId: a },
    b: { x: 4000, y: 0, nodeId: b },
    offset: -600,
    override: null,
  };
  scene.shapes[dim.id] = dim;
  return { scene, dim, wall, a, b };
}

const dimOf = (scene: ReturnType<typeof sceneWithWall>['scene'], id: string): DimensionShape => {
  const s = scene.shapes[id];
  assert.equal(s.shape, 'dimension');
  return s as DimensionShape;
};

test('実測値が2点間の距離と一致する', () => {
  const { scene, dim } = sceneWithWall();
  const g = dimensionGeometry(scene, dim, scene.standard)!;
  assert.ok(g);
  assert.equal(Math.round(g.value), 4000);
  assert.equal(g.text, '4000');
});

test('紐づけた角を動かすと寸法の値が追従する', () => {
  const { scene, dim, b } = sceneWithWall();
  moveNodes(scene, [b], vec(1000, 0));
  const g = dimensionGeometry(scene, dim, scene.standard)!;
  assert.equal(Math.round(g.value), 5000, '壁を伸ばしたのに寸法が追従していない');
});

test('値を上書きすると表示だけ変わる', () => {
  const { scene, dim } = sceneWithWall();
  dim.override = '約4000';
  const g = dimensionGeometry(scene, dim, scene.standard)!;
  assert.equal(g.text, '約4000');
  assert.equal(Math.round(g.value), 4000, '実測値まで変わってしまっている');
});

test('寸法線はオフセットの符号が示す側に出る', () => {
  const { scene, dim } = sceneWithWall();
  const below = dimensionGeometry(scene, dim, scene.standard)!;
  assert.ok(below.line.a.y < 0, '下側に出ていない');

  dim.offset = 600;
  const above = dimensionGeometry(scene, dim, scene.standard)!;
  assert.ok(above.line.a.y > 0, '上側に出ていない');
});

test('両端が角に紐づいた寸法のドラッグは、出す位置だけ変える', () => {
  const { scene, dim } = sceneWithWall();
  const moved = moveDimension(scene, dim, vec(500, -300));
  assert.equal(moved.a.nodeId, dim.a.nodeId, '端点の紐づけが外れている');
  // 法線は perp((1,0)) = (0,1) なので、変位の y 成分だけがオフセットに乗る
  assert.equal(moved.offset, dim.offset - 300);
});

test('自由点の寸法のドラッグは、その点ごと動く', () => {
  const { scene } = sceneWithWall();
  const free: DimensionShape = {
    id: 'd2',
    shape: 'dimension',
    layerId: LAYER_IDS.dimension,
    levelId: DEFAULT_LEVEL_ID,
    attrs: defaultAttrs(),
    a: { x: 0, y: 1000, nodeId: null },
    b: { x: 2000, y: 1000, nodeId: null },
    offset: 300,
    override: null,
  };
  const moved = moveDimension(scene, free, vec(500, 500));
  assert.deepEqual(moved.a, { x: 500, y: 1500, nodeId: null });
  assert.deepEqual(moved.b, { x: 2500, y: 1500, nodeId: null });
  assert.equal(moved.offset, 300, 'オフセットまで動いている');
});

test('鏡像で寸法の出る側が反転する', () => {
  const { scene, dim, wall } = sceneWithWall();
  const before = dim.offset;
  transformEntities(scene, [{ type: 'wall', id: wall.id }, { type: 'shape', id: dim.id }], mirror(vec(0, 0), vec(1, 0)), {
    copy: false,
  });
  assert.equal(dimOf(scene, dim.id).offset, -before);
});

test('複写した寸法は、コピー側の角に付け替わる', () => {
  const { scene, dim, wall } = sceneWithWall();
  const result = transformEntities(
    scene,
    [
      { type: 'wall', id: wall.id },
      { type: 'shape', id: dim.id },
    ],
    translation(vec(0, 10000)),
    { copy: true },
  );
  const copiedDim = result.refs.map((r) => scene.shapes[r.id]).find((s) => s?.shape === 'dimension') as DimensionShape;
  assert.ok(copiedDim, '寸法が複製されていない');
  assert.notEqual(copiedDim.a.nodeId, dim.a.nodeId, '元の角を測り続けている');
  assert.ok(copiedDim.a.nodeId, '紐づけが外れてしまっている');

  // 元の壁を伸ばしてもコピーの値は変わらない
  const beforeValue = dimensionGeometry(scene, copiedDim, scene.standard)!.value;
  moveNodes(scene, [wall.b], vec(2000, 0));
  assert.equal(dimensionGeometry(scene, copiedDim, scene.standard)!.value, beforeValue);
});

test('壁を複写せずに寸法だけ複写すると、紐づけが外れて自由点になる', () => {
  const { scene, dim } = sceneWithWall();
  const result = transformEntities(scene, [{ type: 'shape', id: dim.id }], translation(vec(0, 5000)), { copy: true });
  const copied = scene.shapes[result.refs[0].id] as DimensionShape;
  assert.equal(copied.a.nodeId, null, 'コピーが元の壁を測り続けている');
  assert.equal(copied.b.nodeId, null);
  assert.equal(Math.round(dimensionGeometry(scene, copied, scene.standard)!.value), 4000);
});

test('サンプル間取りに壁ぶんの寸法が入っている', () => {
  const scene = sampleScene();
  const dims = Object.values(scene.shapes).filter((s) => s.shape === 'dimension');
  assert.equal(dims.length, Object.keys(scene.walls).length, '壁の数と寸法の数が合わない');
  for (const d of dims as DimensionShape[]) {
    assert.ok(d.a.nodeId && d.b.nodeId, '壁の角に紐づいていない');
    assert.ok(dimensionGeometry(scene, d, scene.standard), '幾何が作れない');
  }
});

test('寸法が実体になる前のファイルは読み込み時に変換される', () => {
  const scene = sampleScene();
  // 寸法を持たない version 3 のファイルを作る
  const legacy = JSON.parse(JSON.stringify(serialize(scene)));
  legacy.version = 3;
  legacy.scene.shapes = {};

  const restored = deserialize(legacy);
  const dims = Object.values(restored.shapes).filter((s) => s.shape === 'dimension');
  assert.equal(dims.length, Object.keys(restored.walls).length, '壁ぶんの寸法が作られていない');
});

test('現行バージョンのファイルには寸法を生やさない', () => {
  const scene = sampleScene();
  const current = JSON.parse(JSON.stringify(serialize(scene)));
  assert.equal(current.version, FILE_VERSION);
  const restored = deserialize(current);
  assert.equal(
    Object.values(restored.shapes).filter((s) => s.shape === 'dimension').length,
    Object.values(scene.shapes).filter((s) => s.shape === 'dimension').length,
    '寸法が二重に作られている',
  );
});

test('format を持たない生の JSON には寸法を生やさない', () => {
  const restored = deserialize({
    nodes: { n1: { x: 0, y: 0 }, n2: { x: 4000, y: 0 } },
    walls: { w1: { a: 'n1', b: 'n2', thickness: 120 } },
  });
  assert.equal(Object.keys(restored.shapes).length, 0);
});

test('寸法が JSON 往復で保たれる', () => {
  const { scene, dim } = sceneWithWall();
  dim.override = '芯々4000';
  const restored = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.deepEqual(restored.shapes[dim.id], scene.shapes[dim.id]);
});

test('寸法が DXF に線と文字として出る', () => {
  const scene = sampleScene();
  const parsed = new DxfParser().parseSync(sceneToDxf(scene, [], defaultSettings(), { escapeUnicode: false }))!;
  const dimLayer = scene.layers[LAYER_IDS.dimension].name;
  const onDim = parsed.entities.filter((e) => e.layer === dimLayer);
  assert.ok(onDim.some((e) => e.type === 'LINE'), '寸法線が出ていない');
  assert.ok(onDim.some((e) => e.type === 'TEXT'), '寸法値が出ていない');
  // 壁の長さ 4600 がどこかに出ている
  assert.ok(onDim.some((e) => e.type === 'TEXT' && e.text === '4600'), '寸法値が合わない');
});

test('寸法の画層を隠すと書き出しからも消える', () => {
  const scene = sampleScene();
  scene.layers[LAYER_IDS.dimension].visible = false;
  const svg = sceneToSvg(scene, [], defaultSettings());
  assert.ok(!svg.includes('>4600<'), '非表示の寸法が SVG に出ている');
});

test('短すぎる壁には寸法を作らない', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(50, 0));
  addWall(scene, a, b, 100);
  assert.equal(createWallDimensions(scene).length, 0);
  assert.ok(dist(vec(0, 0), vec(50, 0)) < 100);
});

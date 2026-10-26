import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, type Scene } from '../src/core/types.ts';
import { addWall, findOrCreateNode, nodePos, openingsOnWall, wallEnds, wallLength } from '../src/core/ops.ts';
import { extendShape, extendWall, offsetShape, offsetWall, trimShape, trimWall, cutterCurves } from '../src/core/modify.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { dist, vec, type Vec } from '../src/core/geometry.ts';
import { newId } from '../src/core/id.ts';
import type { Shape } from '../src/core/shapes.ts';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const nearPt = (a: Vec, b: Vec, eps = 1e-6) => near(a.x, b.x, eps) && near(a.y, b.y, eps);

function addLine(scene: Scene, ax: number, ay: number, bx: number, by: number): string {
  const id = newId('s');
  const shape: Shape = { id, shape: 'line', layerId: LAYER_IDS.shape, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(), a: vec(ax, ay), b: vec(bx, by) };
  scene.shapes[id] = shape;
  return id;
}

const lineOf = (scene: Scene, id: string) => {
  const s = scene.shapes[id];
  assert.equal(s?.shape, 'line');
  return s as Extract<Shape, { shape: 'line' }>;
};

test('交差する2本の線をトリムできる', () => {
  const scene = emptyScene();
  const horizontal = addLine(scene, -100, 0, 100, 0);
  addLine(scene, 0, -100, 0, 100);

  assert.equal(trimShape(scene, horizontal, vec(-50, 0)), true);
  // 元が消えて、右半分だけが残る
  assert.equal(scene.shapes[horizontal], undefined);
  const lines = Object.values(scene.shapes).filter((s) => s.shape === 'line');
  assert.equal(lines.length, 2, '縦線と右半分の2本になるはず');
  const remaining = lines.find((s) => s.id !== horizontal && (s as never as { a: Vec }).a.y === 0) as never as {
    a: Vec;
    b: Vec;
  };
  assert.ok(nearPt(remaining.a, vec(0, 0)) && nearPt(remaining.b, vec(100, 0)));
});

test('交差していない線のトリムは何もしない', () => {
  const scene = emptyScene();
  const line = addLine(scene, 0, 0, 100, 0);
  addLine(scene, 0, 50, 100, 50);
  assert.equal(trimShape(scene, line, vec(50, 0)), false);
  assert.ok(scene.shapes[line], '何もしないはずが消えている');
});

test('ポリラインはトリムの対象外', () => {
  const scene = emptyScene();
  const id = newId('s');
  scene.shapes[id] = {
    id,
    shape: 'polyline',
    layerId: LAYER_IDS.shape,
    levelId: DEFAULT_LEVEL_ID,
    attrs: defaultAttrs(),
    points: [vec(0, 0), vec(100, 0), vec(100, 100)],
    closed: false,
  };
  addLine(scene, 50, -50, 50, 50);
  assert.equal(trimShape(scene, id, vec(20, 0)), false);
});

test('線を境界まで延長できる', () => {
  const scene = emptyScene();
  const line = addLine(scene, 0, 0, 100, 0);
  addLine(scene, 300, -50, 300, 50);

  assert.equal(extendShape(scene, line, vec(100, 0)), true);
  assert.ok(nearPt(lineOf(scene, line).b, vec(300, 0)), JSON.stringify(lineOf(scene, line).b));
  assert.ok(nearPt(lineOf(scene, line).a, vec(0, 0)), '反対の端が動いている');
});

test('延長したあとも id が変わらない', () => {
  const scene = emptyScene();
  const line = addLine(scene, 0, 0, 100, 0);
  addLine(scene, 300, -50, 300, 50);
  extendShape(scene, line, vec(100, 0));
  assert.ok(scene.shapes[line], '延長で id が変わってしまっている');
});

test('線をオフセットすると平行な線が増える', () => {
  const scene = emptyScene();
  const line = addLine(scene, 0, 0, 1000, 0);
  const created = offsetShape(scene, line, 200, vec(500, 300))!;
  assert.ok(created);
  const copy = lineOf(scene, created);
  assert.ok(nearPt(copy.a, vec(0, 200)), `上側に出ていない: ${JSON.stringify(copy.a)}`);
  assert.ok(scene.shapes[line], '元が消えている');

  // 反対側をクリックすれば反対側に出る
  const below = lineOf(scene, offsetShape(scene, line, 200, vec(500, -300))!);
  assert.ok(nearPt(below.a, vec(0, -200)));
});

test('円のオフセットは内外で半径が変わる', () => {
  const scene = emptyScene();
  const id = newId('s');
  scene.shapes[id] = { id, shape: 'circle', layerId: LAYER_IDS.shape, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(), center: vec(0, 0), radius: 500 };

  const outer = scene.shapes[offsetShape(scene, id, 100, vec(1000, 0))!];
  assert.equal(outer.shape === 'circle' && outer.radius, 600);
  const inner = scene.shapes[offsetShape(scene, id, 100, vec(0, 0))!];
  assert.equal(inner.shape === 'circle' && inner.radius, 400);
});

test('半径より大きく内側へオフセットはできない', () => {
  const scene = emptyScene();
  const id = newId('s');
  scene.shapes[id] = { id, shape: 'circle', layerId: LAYER_IDS.shape, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(), center: vec(0, 0), radius: 100 };
  assert.equal(offsetShape(scene, id, 200, vec(0, 0)), null);
});

test('文字と点はオフセットできない', () => {
  const scene = emptyScene();
  const id = newId('s');
  scene.shapes[id] = { id, shape: 'point', layerId: LAYER_IDS.shape, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(), at: vec(0, 0) };
  assert.equal(offsetShape(scene, id, 100, vec(100, 100)), null);
});

test('ロックされた画層の図形は相手にしない', () => {
  const scene = emptyScene();
  const line = addLine(scene, -100, 0, 100, 0);
  addLine(scene, 0, -100, 0, 100);
  assert.equal(cutterCurves(scene, { shapeId: line }).length, 1);

  scene.layers[LAYER_IDS.shape].locked = true;
  assert.equal(cutterCurves(scene, { shapeId: line }).length, 0, 'ロック中の図形を相手にしている');
});

// --- 壁 ---

test('壁を延長すると角が閉じて部屋ができる', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const c = findOrCreateNode(scene, vec(4000, 3000));
  const d = findOrCreateNode(scene, vec(0, 3000));
  addWall(scene, a, b, 100);
  addWall(scene, b, c, 100);
  addWall(scene, c, d, 100);
  // 最後の1辺を 500mm 手前で止める
  const shortWall = addWall(scene, d, findOrCreateNode(scene, vec(0, 500)), 100)!;

  assert.equal(detectRooms(scene).length, 0, '前提: まだ閉じていない');
  assert.equal(extendWall(scene, shortWall.id, vec(0, 400)), true);
  assert.equal(detectRooms(scene).length, 1, '角が閉じていない');
});

test('壁をオフセットすると厚みと画層を引き継いだ平行な壁ができる', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const wall = addWall(scene, a, b, 250, LAYER_IDS.axis)!;

  const created = offsetWall(scene, wall.id, 900, vec(2000, 500))!;
  assert.ok(created);
  const copy = scene.walls[created];
  assert.equal(copy.thickness, 250);
  assert.equal(copy.layerId, LAYER_IDS.axis);
  const [ca] = wallEnds(scene, copy);
  assert.ok(nearPt(ca, vec(0, 900)), JSON.stringify(ca));
  assert.ok(near(wallLength(scene, copy), 4000));
});

test('壁をトリムすると、クリックした側が消える', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(-2000, 0));
  const b = findOrCreateNode(scene, vec(2000, 0));
  const target = addWall(scene, a, b, 100)!;
  // 交差する壁
  addWall(scene, findOrCreateNode(scene, vec(0, -1000)), findOrCreateNode(scene, vec(0, 1000)), 100);

  assert.equal(trimWall(scene, target.id, vec(-1000, 0)), true);
  const horizontal = Object.values(scene.walls).filter((w) => {
    const [wa, wb] = wallEnds(scene, w);
    return Math.abs(wa.y) < 1 && Math.abs(wb.y) < 1;
  });
  assert.equal(horizontal.length, 1, '水平な壁が1本だけ残るはず');
  const [ha, hb] = wallEnds(scene, horizontal[0]);
  assert.ok(Math.min(ha.x, hb.x) >= -1, `左側が残っている: ${ha.x}, ${hb.x}`);
});

test('壁のトリムで、切断線をまたぐ開口部は消える', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(-2000, 0));
  const b = findOrCreateNode(scene, vec(2000, 0));
  const target = addWall(scene, a, b, 100)!;
  addWall(scene, findOrCreateNode(scene, vec(0, -1000)), findOrCreateNode(scene, vec(0, 1000)), 100);

  // 中央（切断線の上）にまたがる開口
  const openingId = newId('o');
  scene.openings[openingId] = {
    id: openingId,
    wallId: target.id,
    offset: 2000,
    width: 1600,
    kind: 'door',
    flipX: false,
    flipY: false,
    sillHeight: null,
    bay: null,
    designation: '',
    leaves: 2,
    height: null,
    layerId: LAYER_IDS.opening,
    attrs: defaultAttrs(),
  };

  trimWall(scene, target.id, vec(-1000, 0));
  assert.equal(scene.openings[openingId], undefined, '行き場のない開口が残っている');
});

test('交差相手が無い壁は延長もトリムもできない', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(1000, 0));
  const wall = addWall(scene, a, b, 100)!;
  assert.equal(extendWall(scene, wall.id, vec(1000, 0)), false);
  assert.equal(trimWall(scene, wall.id, vec(500, 0)), false);
  assert.ok(near(dist(nodePos(scene, a), nodePos(scene, b)), 1000), '何もしないはずが動いている');
  assert.equal(openingsOnWall(scene, wall.id).length, 0);
});

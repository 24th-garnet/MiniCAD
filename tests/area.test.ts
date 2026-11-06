import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, type Scene, type EntityRef } from '../src/core/types.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { areasFromShapes } from '../src/core/area.ts';
import { sceneToMeasures } from '../src/io/measures.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { vec, type Vec } from '../src/core/geometry.ts';

/**
 * 外部領域（22 段）。ワイヤー 8 枚目「ペイント／直線・矩形・曲線・**外部領域**」。
 *
 * **仕様に説明が無い。** すぐ上の「※COOHOMの内容を踏襲」に従って、COOHOM の
 * External Area に合わせた——中庭・テラスなど、既存の部屋の**外側**にある、
 * **天井も壁も無い独立したスラブ**で、**部屋として扱われる**。
 */

const square = (x0: number, y0: number, x1: number, y1: number): Vec[] =>
  [vec(x0, y0), vec(x1, y0), vec(x1, y1), vec(x0, y1)];

function withWalls(scene: Scene, x0: number, y0: number, x1: number, y1: number): void {
  const ids = square(x0, y0, x1, y1).map((p) => findOrCreateNode(scene, p));
  for (let i = 0; i < 4; i++) addWall(scene, ids[i], ids[(i + 1) % 4], 100);
}

/** 閉じたポリラインを 1 つ置いて、その参照を返す */
function closedShape(scene: Scene, points: Vec[]): EntityRef {
  const id = 'sh-1';
  scene.shapes[id] = {
    id, shape: 'polyline', points, closed: true,
    layerId: LAYER_IDS.shape, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(),
  };
  return { type: 'shape', id };
}

test('閉じた図形が外部領域になり、元の図形は消える', () => {
  const scene = emptyScene();
  const ref = closedShape(scene, square(0, 0, 4000, 3000));
  const r = areasFromShapes(scene, [ref], []);
  assert.equal(r.created.length, 1, '作られていない');
  assert.equal(Object.keys(scene.shapes).length, 0, '元の図形が残っている');
  assert.equal(Object.keys(scene.areas).length, 1);
});

test('外部領域は部屋として数えられる（壁は持たない）', () => {
  const scene = emptyScene();
  areasFromShapes(scene, [closedShape(scene, square(0, 0, 4000, 3000))], []);
  const rooms = detectRooms(scene);
  assert.equal(rooms.length, 1, '部屋として出ていない');
  const room = rooms[0];
  assert.equal(room.outdoor, true, '屋外の札が立っていない');
  assert.deepEqual(room.wallIds, [], '壁を持っている');
  // 壁が無いので壁芯と内法が同じ。4.0m × 3.0m
  assert.ok(Math.abs(room.area - 12) < 1e-6, `area=${room.area}`);
  assert.ok(Math.abs(room.innerArea - 12) < 1e-6, '内法が壁芯と違う');
});

test('階は自分で持つ（壁から引かない）', () => {
  // **ここが以前いちばん危なかった。** 部屋の階は wallIds[0] から引いていたので、
  // 壁を持たない領域では作業中の階に落ちていた——2 階のテラスが 1 階に出る
  const scene = emptyScene();
  const ref = closedShape(scene, square(0, 0, 2000, 2000));
  scene.shapes[ref.id].levelId = 'lv-2';
  scene.levels['lv-2'] = { ...Object.values(scene.levels)[0], id: 'lv-2', name: '2F', floorZ: 3000 };
  areasFromShapes(scene, [ref], []);
  const room = detectRooms(scene).find((r) => r.outdoor)!;
  assert.equal(room.levelId, 'lv-2', '階が引き継がれていない');
});

test('部屋と重なっていたら断る', () => {
  // COOHOM の決まり——外部領域は既存の部屋の外側にしか置けない。
  // 黙って重ねると同じ床を 2 回数えることになる
  const scene = emptyScene();
  withWalls(scene, 0, 0, 4000, 3000);
  const rooms = detectRooms(scene).map((r) => r.innerPolygon);
  const inside = areasFromShapes(scene, [closedShape(scene, square(1000, 1000, 2000, 2000))], rooms);
  assert.equal(inside.created.length, 0, '部屋の中に作れてしまった');
  assert.equal(inside.overlapped, 1, '理由が数えられていない');
  // 外側なら通る
  const outside = areasFromShapes(scene, [closedShape(scene, square(5000, 0, 8000, 2000))], rooms);
  assert.equal(outside.created.length, 1, '部屋の外なのに断られた');
});

test('閉じていない図形は断る', () => {
  const scene = emptyScene();
  const ref = closedShape(scene, square(0, 0, 1000, 1000));
  const open = scene.shapes[ref.id];
  if (open.shape === 'polyline') open.closed = false;
  const r = areasFromShapes(scene, [ref], []);
  assert.equal(r.created.length, 0);
  assert.equal(r.notClosed, 1);
});

test('積算では部屋と別に並び、天井は持たない', () => {
  const scene = emptyScene();
  withWalls(scene, 0, 0, 4000, 3000);
  const rooms0 = detectRooms(scene).map((r) => r.innerPolygon);
  areasFromShapes(scene, [closedShape(scene, square(5000, 0, 7000, 2000))], rooms0);
  const rooms = detectRooms(scene);
  const m = sceneToMeasures(scene, rooms, { planId: 'p-1' });

  assert.equal(m.rooms.length, 1, '屋内が 1 つでない');
  assert.ok(m.exterior_areas, '外部領域の欄が出ていない');
  assert.equal(m.exterior_areas.length, 1);
  const terrace = m.exterior_areas[0];
  // 2.0m × 2.0m
  assert.ok(Math.abs(terrace.floor_area - 4) < 1e-6, `床=${terrace.floor_area}`);
  // **屋外に天井は無い。** 床と同じ数を入れると天井を仕上げてしまう
  assert.equal(terrace.ceiling_area, 0, '天井面積が立っている');
  assert.equal(terrace.wall_area, 0, '壁面積が立っている');
  assert.deepEqual(terrace.openings, []);
  // 屋内の合計に混ざっていない
  assert.ok(Math.abs(m.rooms[0].floor_area - 11.31) < 1e-6, '屋内の床が変わった');
});

test('外部領域が無ければ、積算の形はこれまでと同じ', () => {
  const scene = emptyScene();
  withWalls(scene, 0, 0, 4000, 3000);
  const m = sceneToMeasures(scene, detectRooms(scene), { planId: 'p-1' });
  assert.equal('exterior_areas' in m, false, '空の欄が出ている');
});

test('保存して読み直しても残る', () => {
  const scene = emptyScene();
  areasFromShapes(scene, [closedShape(scene, square(0, 0, 3000, 2000))], []);
  const back = deserialize(serialize(scene));
  const areas = Object.values(back.areas);
  assert.equal(areas.length, 1, '読み直しで消えた');
  assert.equal(areas[0].outline.length, 4);
  assert.equal(detectRooms(back).length, 1, '読み直したら部屋として出ない');
});

test('室名ラベルが外部領域にも付く（名前の付け方を 2 つにしない）', () => {
  const scene = emptyScene();
  areasFromShapes(scene, [closedShape(scene, square(0, 0, 4000, 3000))], []);
  scene.roomLabels['rl-1'] = {
    id: 'rl-1', x: 2000, y: 1500, name: 'テラス',
    floorMaterial: null, ceilingMaterial: null,
    layerId: LAYER_IDS.roomName, levelId: DEFAULT_LEVEL_ID,
  };
  const room = detectRooms(scene)[0];
  assert.equal(room.name, 'テラス', '室名が付かない');
  assert.equal(room.labelId, 'rl-1');
});

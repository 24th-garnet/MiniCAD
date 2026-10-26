import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene } from '../src/core/types.ts';
import { addWall, findOrCreateNode, splitWall, wallLength } from '../src/core/ops.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { vec } from '../src/core/geometry.ts';

function rect(scene: ReturnType<typeof emptyScene>, x0: number, y0: number, x1: number, y1: number, t = 100) {
  const ids = [
    findOrCreateNode(scene, vec(x0, y0)),
    findOrCreateNode(scene, vec(x1, y0)),
    findOrCreateNode(scene, vec(x1, y1)),
    findOrCreateNode(scene, vec(x0, y1)),
  ];
  for (let i = 0; i < 4; i++) addWall(scene, ids[i], ids[(i + 1) % 4], t);
  return ids;
}

test('単一の矩形から部屋を1つ検出する', () => {
  const scene = emptyScene();
  rect(scene, 0, 0, 4000, 3000, 100);
  const rooms = detectRooms(scene);
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].polygon.length, 4);
  // 壁芯面積 4.0m x 3.0m = 12.0 m2
  assert.ok(Math.abs(rooms[0].area - 12) < 1e-6, `area=${rooms[0].area}`);
  // 内法 3.9m x 2.9m = 11.31 m2
  assert.ok(Math.abs(rooms[0].innerArea - 11.31) < 1e-6, `inner=${rooms[0].innerArea}`);
});

test('壁を共有する2部屋を別々に検出する', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(3000, 0));
  const c = findOrCreateNode(scene, vec(6000, 0));
  const d = findOrCreateNode(scene, vec(6000, 3000));
  const e = findOrCreateNode(scene, vec(3000, 3000));
  const f = findOrCreateNode(scene, vec(0, 3000));
  for (const [p, q] of [[a, b], [b, c], [c, d], [d, e], [e, f], [f, a], [b, e]] as const) {
    addWall(scene, p, q, 100);
  }
  const rooms = detectRooms(scene);
  assert.equal(rooms.length, 2);
  for (const r of rooms) assert.ok(Math.abs(r.area - 9) < 1e-6, `area=${r.area}`);
});

test('行き止まりの壁は部屋にならない', () => {
  const scene = emptyScene();
  rect(scene, 0, 0, 4000, 3000);
  const inside = findOrCreateNode(scene, vec(2000, 1500));
  const corner = findOrCreateNode(scene, vec(0, 0));
  addWall(scene, corner, inside, 100);
  const rooms = detectRooms(scene);
  assert.equal(rooms.length, 1);
});

test('閉じていない壁からは部屋を検出しない', () => {
  const scene = emptyScene();
  const ids = [
    findOrCreateNode(scene, vec(0, 0)),
    findOrCreateNode(scene, vec(4000, 0)),
    findOrCreateNode(scene, vec(4000, 3000)),
  ];
  addWall(scene, ids[0], ids[1], 100);
  addWall(scene, ids[1], ids[2], 100);
  assert.equal(detectRooms(scene).length, 0);
});

test('部屋ラベルは内側に置かれた部屋に結びつく', () => {
  const scene = emptyScene();
  rect(scene, 0, 0, 4000, 3000);
  scene.roomLabels['L1'] = {
    id: 'L1', x: 2000, y: 1500, name: 'リビング',
    layerId: LAYER_IDS.roomName, levelId: DEFAULT_LEVEL_ID,
  };
  const rooms = detectRooms(scene);
  assert.equal(rooms[0].name, 'リビング');
});

test('壁の分割で開口部が正しい側に引き継がれる', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const wall = addWall(scene, a, b, 100)!;
  scene.openings['o1'] = { id: 'o1', wallId: wall.id, offset: 500, width: 800, kind: 'door', flipX: false, flipY: false };
  scene.openings['o2'] = { id: 'o2', wallId: wall.id, offset: 3000, width: 800, kind: 'window', flipX: false, flipY: false };
  const midId = splitWall(scene, wall.id, vec(2000, 0))!;
  assert.ok(midId);
  assert.equal(scene.openings['o1'].wallId, wall.id);
  assert.equal(scene.openings['o2'].offset, 1000);
  assert.notEqual(scene.openings['o2'].wallId, wall.id);
  assert.ok(Math.abs(wallLength(scene, scene.walls[wall.id]) - 2000) < 1e-9);
});

test('階が違えば同じ座標でも別の部屋になる', () => {
  // ノードが階を持つので、壁グラフは階ごとに分かれる。
  // ここが壊れると 1 階と 2 階の壁が 1 つの部屋として閉じてしまう。
  const scene = emptyScene();
  scene.levels['lv-2'] = { id: 'lv-2', name: '2階', floorZ: 2400, wallHeight: 2400 };

  rect(scene, 0, 0, 4000, 3000);
  scene.activeLevelId = 'lv-2';
  rect(scene, 0, 0, 4000, 3000);

  const rooms = detectRooms(scene);
  assert.equal(rooms.length, 2, '同じ座標の 2 階ぶんが 1 部屋に溶けている');
  const levels = rooms.map((r) => scene.walls[r.wallIds[0]].levelId).sort();
  assert.deepEqual(levels, ['lv-1', 'lv-2']);
});

test('階が違えば同じ座標のノードを使い回さない', () => {
  const scene = emptyScene();
  scene.levels['lv-2'] = { id: 'lv-2', name: '2階', floorZ: 2400, wallHeight: 2400 };

  const a = findOrCreateNode(scene, vec(0, 0), 'lv-1');
  const b = findOrCreateNode(scene, vec(0, 0), 'lv-2');
  assert.notEqual(a, b, '階をまたいでノードが融合した');

  const again = findOrCreateNode(scene, vec(0, 0), 'lv-1');
  assert.equal(again, a, '同じ階では使い回されていない');
});

test('階をまたいだ壁は作れない', () => {
  const scene = emptyScene();
  scene.levels['lv-2'] = { id: 'lv-2', name: '2階', floorZ: 2400, wallHeight: 2400 };
  const a = findOrCreateNode(scene, vec(0, 0), 'lv-1');
  const b = findOrCreateNode(scene, vec(4000, 0), 'lv-2');
  assert.equal(addWall(scene, a, b, 100), null);
});

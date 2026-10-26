import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomElevation, roomElevationsToSvg, sceneToRoomElevations } from '../src/io/elevation.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { vec } from '../src/core/geometry.ts';
import { emptyScene, type Scene } from '../src/core/types.ts';
import { makeOpening } from './make.ts';
import { sampleScene } from '../src/io/sample.ts';

/**
 * 4000 × 3000 の部屋。
 *
 * **壁 2 だけ逆向きに引く。** 実際の作図では壁の向きはばらばらで、
 * 全部が部屋の巡回と同じ向きに並ぶとは限らない。全部同じ向きで作ると、
 * 向き合わせを外してもテストが通ってしまう（一度そうなった）。
 */
function boxRoom(): { scene: Scene; wallIds: string[] } {
  const scene = emptyScene();
  const c = [vec(0, 0), vec(4000, 0), vec(4000, 3000), vec(0, 3000)].map((p) => findOrCreateNode(scene, p));
  const wallIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const [from, to] = i === 2 ? [c[(i + 1) % 4], c[i]] : [c[i], c[(i + 1) % 4]];
    wallIds.push(addWall(scene, from, to, 100)!.id);
  }
  return { scene, wallIds };
}

test('部屋の壁ぶんの面が出て、A から順に名前が付く', () => {
  const { scene } = boxRoom();
  const rooms = detectRooms(scene);
  const got = roomElevation(scene, rooms[0])!;
  assert.ok(got);
  assert.equal(got.faces.length, 4, `面が ${got.faces.length} 枚`);
  assert.deepEqual(got.faces.map((f) => f.name), ['A', 'B', 'C', 'D']);
});

test('各面は部屋を一周する向きで測られる（面どうしが角で繋がる）', () => {
  // **これが展開図の定義。** 面 A の右端と面 B の左端が、平面図の同じ角を指す。
  // 揃えないと 1 面だけ建具が左右逆の位置に出る。
  //
  // 確かめ方: 開口の `lo` が「巡回の始点からの距離」と一致すること。
  // 壁自身の始点からの距離と比べてはいけない——壁の向きはばらばらなので
  const { scene, wallIds } = boxRoom();
  for (const wallId of wallIds) {
    const op = makeOpening(wallId, { kind: 'door', offset: 900, width: 800 });
    scene.openings[op.id] = op;
  }

  const room = detectRooms(scene)[0];
  const got = roomElevation(scene, room)!;

  got.faces.forEach((face, i) => {
    const wall = scene.walls[face.elevation.wallId];
    const from = room.polygon[i];               // 巡回の始点
    const a = scene.nodes[wall.a];
    const opening = scene.openings[
      Object.keys(scene.openings).find((id) => scene.openings[id].wallId === wall.id)!
    ];
    // 開口の中心が、巡回の始点からどれだけ先にあるか
    const alongFromA = opening.offset;
    const matches = Math.hypot(a.x - from.x, a.y - from.y) < 1;
    const expected = (matches ? alongFromA : face.elevation.length - alongFromA) - opening.width / 2;
    assert.ok(
      Math.abs(face.elevation.openings[0].lo - expected) < 1,
      `${face.name} 面: ${face.elevation.openings[0].lo} にあるが ${expected} のはず`,
    );
  });
});

test('巡回と逆向きの壁が実際に混ざっている（テストが判別している証拠）', () => {
  // **全部同じ向きだと、向き合わせを外してもテストが通る。** 一度そうなった
  const { scene } = boxRoom();
  const room = detectRooms(scene)[0];
  const reversed = room.wallIds.filter((wallId, i) => {
    const a = scene.nodes[scene.walls[wallId].a];
    const from = room.polygon[i];
    return Math.hypot(a.x - from.x, a.y - from.y) >= 1;
  });
  assert.ok(reversed.length > 0, '逆向きの壁が無いので、このテストは何も見ていない');
});

test('反転しても壁の長さと開口の幅は変わらない', () => {
  const { scene, wallIds } = boxRoom();
  const op = makeOpening(wallIds[2], { kind: 'window', offset: 1500, width: 1200 });
  scene.openings[op.id] = op;
  const got = roomElevation(scene, detectRooms(scene)[0])!;
  for (const f of got.faces) {
    for (const o of f.elevation.openings) {
      assert.ok(Math.abs((o.hi - o.lo) - 1200) < 1, `幅が ${o.hi - o.lo}`);
      assert.ok(o.lo >= 0 && o.hi <= f.elevation.length, '壁からはみ出している');
    }
  }
});

test('同じ壁を二度出さない', () => {
  // 行き止まりの壁は巡回に 2 度現れる
  const { scene } = boxRoom();
  const a = findOrCreateNode(scene, vec(2000, 1500));
  const b = findOrCreateNode(scene, vec(2000, 2500));
  addWall(scene, a, b, 100);
  const got = roomElevation(scene, detectRooms(scene)[0])!;
  const ids = got.faces.map((f) => f.elevation.wallId);
  assert.equal(new Set(ids).size, ids.length, '同じ壁が二度出ている');
});

test('展開図の SVG が 1 枚の正しい SVG になる', () => {
  const scene = sampleScene();
  const got = sceneToRoomElevations(scene, detectRooms(scene));
  assert.ok(got.length > 0);
  const svg = roomElevationsToSvg(got);
  assert.equal(svg.match(/<svg/g)?.length, 1, 'svg が 1 枚ではない');
  assert.ok(svg.trimEnd().endsWith('</svg>'));
  assert.ok(svg.includes('LDK'), '部屋名が出ていない');
  assert.ok(svg.includes('A 面'), '面の名前が出ていない');
  // **持っていないものは、持っていないと書く**
  assert.ok(svg.includes('未計測'), '但し書きが消えている');
});

test('壁で閉じた部屋が無ければ展開図は出ない', () => {
  const scene = emptyScene();
  assert.deepEqual(sceneToRoomElevations(scene, detectRooms(scene)), []);
});

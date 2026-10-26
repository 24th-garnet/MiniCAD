import { defaultAttrs } from '../src/core/attrs.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene } from '../src/core/types.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { newId } from '../src/core/id.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { detectRooms, perimeterOf, nestingOf } from '../src/core/rooms.ts';
import { vec } from '../src/core/geometry.ts';
import { sceneToMeasures, SCHEMA } from '../src/io/measures.ts';

type Scene = ReturnType<typeof emptyScene>;

function rect(scene: Scene, x0: number, y0: number, x1: number, y1: number, t = 100) {
  const ids = [
    findOrCreateNode(scene, vec(x0, y0)),
    findOrCreateNode(scene, vec(x1, y0)),
    findOrCreateNode(scene, vec(x1, y1)),
    findOrCreateNode(scene, vec(x0, y1)),
  ];
  const walls: string[] = [];
  for (let i = 0; i < 4; i++) {
    const w = addWall(scene, ids[i], ids[(i + 1) % 4], t);
    if (w) walls.push(w.id);
  }
  return walls;
}

/** 開口を置く。生成関数が無いのでシーンへ直に入れる（既存テストと同じ流儀） */
function addOpening(scene: Scene, wallId: string, offset: number, width: number,
                    kind: 'door' | 'window') {
  const id = newId('o');
  scene.openings[id] = {
    id, wallId, offset, width, kind,
    flipX: false, flipY: false, sillHeight: null, height: null, bay: null, designation: '', leaves: 2,
    layerId: LAYER_IDS.opening,
    attrs: defaultAttrs(),
  };
  return id;
}

function measure(scene: Scene) {
  return sceneToMeasures(scene, detectRooms(scene), { planId: 'p1', name: 'n' });
}

test('周長はポリゴンの辺長の和', () => {
  assert.equal(perimeterOf([vec(0, 0), vec(100, 0), vec(100, 50), vec(0, 50)]), 300);
});

test('周長は点が2つ未満なら0', () => {
  assert.equal(perimeterOf([]), 0);
  assert.equal(perimeterOf([vec(0, 0)]), 0);
});

test('契約の版を名乗る', () => {
  const scene = emptyScene();
  rect(scene, 0, 0, 4000, 3000);
  assert.equal(measure(scene).schema_version, SCHEMA);
});

test('床面積は内法面積', () => {
  const scene = emptyScene();
  rect(scene, 0, 0, 4000, 3000, 100);
  // 内法 3.9m x 2.9m = 11.31 m2
  assert.equal(measure(scene).rooms[0].floor_area, 11.31);
});

test('周長は内法ポリゴンから出す', () => {
  const scene = emptyScene();
  rect(scene, 0, 0, 4000, 3000, 100);
  // (3900 + 2900) * 2 = 13600
  assert.equal(measure(scene).rooms[0].perimeter, 13600);
});

test('壁の面積は開口を抜いた正味長さに高さを掛ける', () => {
  const scene = emptyScene();
  const walls = rect(scene, 0, 0, 4000, 3000, 100);
  // 壁芯の周長 (4000 + 3000) * 2 = 14000mm、高さ 2400mm → 33.6 m2
  assert.equal(measure(scene).rooms[0].wall_area, 33.6);
  // 幅 800 の開口を 1 つ置くと (14000 - 800) * 2400 = 31.68 m2
  addOpening(scene, walls[0], 2000, 800, 'door');
  assert.equal(measure(scene).rooms[0].wall_area, 31.68);
});

test('開口の高さは床からの下端と上端から出す', () => {
  const scene = emptyScene();
  const walls = rect(scene, 0, 0, 4000, 3000, 100);
  addOpening(scene, walls[0], 2000, 1700, 'window');
  const o = measure(scene).rooms[0].openings[0];
  // 窓は窓台 800、高さ 1100 が既定
  assert.equal(o.sill, 800);
  assert.equal(o.height, 1100);
  assert.equal(o.width, 1700);
});

test('床まで届く建具は窓台が0', () => {
  const scene = emptyScene();
  const walls = rect(scene, 0, 0, 4000, 3000, 100);
  addOpening(scene, walls[0], 2000, 800, 'door');
  assert.equal(measure(scene).rooms[0].openings[0].sill, 0);
});

test('壁の高さが既定に落ちていればそう名乗る', () => {
  const scene = emptyScene();
  rect(scene, 0, 0, 4000, 3000, 100);
  // 作図した壁は height が null（階の既定に落ちる）
  assert.equal(measure(scene).rooms[0].basis.height, '既定');
});

test('天井高を持たないことをシートで名乗る', () => {
  const scene = emptyScene();
  rect(scene, 0, 0, 4000, 3000);
  const m = measure(scene);
  assert.equal(m.basis.ceiling_height, '代用');
  assert.equal(m.basis.swing, '未計測');
});

test('根拠は固定の語彙だけを使う', () => {
  const scene = emptyScene();
  rect(scene, 0, 0, 4000, 3000);
  const allowed = new Set(['実測', '推定', '代用', '既定', '外接', '未検出', '未計測']);
  const m = measure(scene);
  for (const v of Object.values(m.basis)) assert.ok(allowed.has(v), v);
  for (const r of m.rooms) for (const v of Object.values(r.basis)) assert.ok(allowed.has(v), v);
});

// --- 入れ子の控除 ---------------------------------------------------------

function nested(): Scene {
  const scene = emptyScene();
  rect(scene, 0, 0, 6000, 5000, 100);      // 外側
  rect(scene, 2000, 2000, 3000, 3000, 100); // 中の柱型
  return scene;
}

test('部屋の中の部屋を入れ子として見つける', () => {
  const rooms = detectRooms(nested());
  assert.equal(rooms.length, 2);
  const map = nestingOf(rooms);
  assert.equal(map.size, 1);
  const [outer, inners] = [...map.entries()][0];
  assert.equal(inners.length, 1);
  assert.ok(rooms[outer].area > rooms[inners[0]].area);
});

test('隣り合った部屋は入れ子にしない', () => {
  const scene = emptyScene();
  rect(scene, 0, 0, 4000, 3000, 100);
  rect(scene, 4000, 0, 8000, 3000, 100);
  const rooms = detectRooms(scene);
  // **2 室あることを先に固定する。** これが無いと 0 室でも通ってしまう
  assert.equal(rooms.length, 2);
  assert.equal(nestingOf(rooms).size, 0);
});

test('隣り合う2室の数量がそれぞれ出る', () => {
  const scene = emptyScene();
  rect(scene, 0, 0, 4000, 3000, 100);
  rect(scene, 4000, 0, 8000, 3000, 100);
  const m = measure(scene);
  assert.equal(m.rooms.length, 2);
  for (const r of m.rooms) assert.ok(r.floor_area > 0, `床が 0: ${r.id}`);
});

test('入れ子の面積を床から引く', () => {
  const m = sceneToMeasures(nested(), detectRooms(nested()), { planId: 'p' });
  const outer = m.rooms.reduce((a, b) => (a.floor_area > b.floor_area ? a : b));
  // 外側の内法 5.9 x 4.9 = 28.91、中の内法 0.9 x 0.9 = 0.81 → 28.10
  assert.ok(Math.abs(outer.floor_area - 28.1) < 1e-6, `floor=${outer.floor_area}`);
});

test('入れ子の周長は巾木のために足す', () => {
  const m = sceneToMeasures(nested(), detectRooms(nested()), { planId: 'p' });
  const outer = m.rooms.reduce((a, b) => (a.floor_area > b.floor_area ? a : b));
  // 外 (5900 + 4900) * 2 = 21600、柱型 (900 + 900) * 2 = 3600 → 25200
  assert.equal(outer.perimeter, 25200);
});

test('入れ子を控除したら根拠に推定が立つ', () => {
  const m = sceneToMeasures(nested(), detectRooms(nested()), { planId: 'p' });
  const outer = m.rooms.reduce((a, b) => (a.floor_area > b.floor_area ? a : b));
  assert.equal(outer.basis.area, '推定');
});

test('積算の対象外にした壁は幾何ごと外れる', async () => {
  const { sampleScene } = await import('../src/io/sample.ts');
  const { detectRooms } = await import('../src/core/rooms.ts');
  const { sceneToMeasures } = await import('../src/io/measures.ts');

  const scene = sampleScene();
  const before = sceneToMeasures(scene, detectRooms(scene), { planId: 'p' });
  const room = before.rooms[0];
  assert.ok(room.wall_area > 0);

  // その部屋の壁を 1 面だけ対象外にする
  const rooms = detectRooms(scene);
  const wallId = rooms[0].wallIds[0];
  scene.walls[wallId].attrs.takeoff = 'excluded';

  const after = sceneToMeasures(scene, detectRooms(scene), { planId: 'p' });
  assert.ok(after.rooms[0].wall_area < room.wall_area, '壁面積が減っていない');
  // **何を外したかを書く。** 数字だけ渡すと追えない
  assert.equal(after.rooms[0].basis.wall_area, '推定');
  assert.match(after.rooms[0].basis_note.wall_area, /対象外にした壁 1 面/);
});

test('未指定は対象外ではない', async () => {
  // **3 つの状態を畳まない。** 書き忘れが「拾わないと決めた」に化けると、
  // 黙って数量から消える
  const { sampleScene } = await import('../src/io/sample.ts');
  const { detectRooms } = await import('../src/core/rooms.ts');
  const { sceneToMeasures } = await import('../src/io/measures.ts');

  const scene = sampleScene();
  const base = sceneToMeasures(scene, detectRooms(scene), { planId: 'p' });
  for (const w of Object.values(scene.walls)) w.attrs.takeoff = null;
  const same = sceneToMeasures(scene, detectRooms(scene), { planId: 'p' });
  assert.equal(same.rooms[0].wall_area, base.rooms[0].wall_area);
  assert.equal(same.rooms[0].basis.wall_area, undefined, '未指定で根拠が立っている');
});

test('積算の対象外にした家具は員数に入らない', async () => {
  const { sampleScene } = await import('../src/io/sample.ts');
  const { detectRooms } = await import('../src/core/rooms.ts');
  const { sceneToMeasures } = await import('../src/io/measures.ts');

  const scene = sampleScene();
  const before = sceneToMeasures(scene, detectRooms(scene), { planId: 'p' });
  const total = (f: typeof before) => f.rooms.reduce((n, r) => n + r.furniture.length, 0);
  assert.ok(total(before) > 0);

  for (const inst of Object.values(scene.instances)) inst.attrs.takeoff = 'excluded';
  const after = sceneToMeasures(scene, detectRooms(scene), { planId: 'p' });
  assert.equal(total(after), 0, '対象外の家具が残っている');
});

test('建具の対象外は効かない（穴は実在する）', async () => {
  // 拾い側は openings[] を品目の数え上げと壁面積の控除の両方に使うので、
  // 外すと穴が無かったことになって壁が多く出る
  const { sampleScene } = await import('../src/io/sample.ts');
  const { detectRooms } = await import('../src/core/rooms.ts');
  const { sceneToMeasures } = await import('../src/io/measures.ts');

  const scene = sampleScene();
  const before = sceneToMeasures(scene, detectRooms(scene), { planId: 'p' });
  for (const o of Object.values(scene.openings)) o.attrs.takeoff = 'excluded';
  const after = sceneToMeasures(scene, detectRooms(scene), { planId: 'p' });
  assert.deepEqual(
    after.rooms.map((r) => r.openings.length),
    before.rooms.map((r) => r.openings.length),
    '建具が消えている',
  );
});

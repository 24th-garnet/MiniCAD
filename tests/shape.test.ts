import { defaultAttrs } from '../src/core/attrs.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vec } from '../src/core/geometry.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { emptyScene, newId, type Scene, type Wall } from '../src/core/types.ts';
import { wallOutline } from '../src/core/shape.ts';

const THICKNESS = 120;

/** 長さ 4000 の水平な壁。`openings` は [中心位置, 幅] の並び */
export function wallFixture(
  openings: [number, number][],
  { deadEnd = true } = {},
): { scene: Scene; wall: Wall } {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const wall = addWall(scene, a, b, THICKNESS)!;
  if (!deadEnd) {
    // 両端に別の壁を繋いで行き止まりでなくする（端部の小口が消える）
    addWall(scene, a, findOrCreateNode(scene, vec(0, 2000)), THICKNESS);
    addWall(scene, b, findOrCreateNode(scene, vec(4000, 2000)), THICKNESS);
  }
  for (const [offset, width] of openings) {
    const id = newId('o');
    scene.openings[id] = {
      id,
      wallId: wall.id,
      offset,
      width,
      kind: 'opening',
      flipX: false,
      flipY: false,
      sillHeight: null,
      height: null,
      layerId: LAYER_IDS.opening,
      attrs: defaultAttrs(),
    };
  }
  return { scene, wall };
}

const flat = (scene: Scene, wall: Wall): number[][] =>
  wallOutline(scene, wall).map((s) => [s.a.x, s.a.y, s.b.x, s.b.y]);

/**
 * `wallOutline` の座標そのもののゴールデン。
 *
 * この関数は画面の輪郭表示・SVG・DXF が共通で使う。間接的なテスト
 * （線分の本数や「開口を壁線が横切っていないか」）はあったが、
 * 座標を検証するテストが無かったので、区間計算を切り出す前にここで固定した。
 */
const GOLDEN: Record<string, { openings: [number, number][]; deadEnd?: boolean; expect: number[][] }> = {
  '開口なし・行き止まり': {
    openings: [],
    expect: [
      [0, 60, 4000, 60],
      [0, -60, 4000, -60],
      [0, 60, 0, -60],
      [4000, 60, 4000, -60],
    ],
  },
  '開口なし・両端に接続': {
    openings: [],
    deadEnd: false,
    expect: [
      [0, 60, 4000, 60],
      [0, -60, 4000, -60],
    ],
  },
  '中央に開口1つ': {
    openings: [[2000, 800]],
    expect: [
      [0, 60, 1600, 60],
      [0, -60, 1600, -60],
      [2400, 60, 4000, 60],
      [2400, -60, 4000, -60],
      [1600, 60, 1600, -60],
      [2400, 60, 2400, -60],
      [0, 60, 0, -60],
      [4000, 60, 4000, -60],
    ],
  },
  '隣り合う開口2つ': {
    openings: [
      [1200, 600],
      [2800, 600],
    ],
    expect: [
      [0, 60, 900, 60],
      [0, -60, 900, -60],
      [1500, 60, 2500, 60],
      [1500, -60, 2500, -60],
      [3100, 60, 4000, 60],
      [3100, -60, 4000, -60],
      [900, 60, 900, -60],
      [1500, 60, 1500, -60],
      [2500, 60, 2500, -60],
      [3100, 60, 3100, -60],
      [0, 60, 0, -60],
      [4000, 60, 4000, -60],
    ],
  },
  '壁端をはみ出す開口': {
    openings: [[200, 1000]],
    expect: [
      [700, 60, 4000, 60],
      [700, -60, 4000, -60],
      // 開口が壁端まで食い込むと、小口と端部の塞ぎが同じ位置に重なる（既存の挙動）
      [0, 60, 0, -60],
      [700, 60, 700, -60],
      [0, 60, 0, -60],
      [4000, 60, 4000, -60],
    ],
  },
  '壁を覆い尽くす開口': {
    openings: [[2000, 4000]],
    expect: [
      [0, 60, 0, -60],
      [4000, 60, 4000, -60],
      [0, 60, 0, -60],
      [4000, 60, 4000, -60],
    ],
  },
};

for (const [name, g] of Object.entries(GOLDEN)) {
  test(`壁の輪郭線: ${name}`, () => {
    const { scene, wall } = wallFixture(g.openings, { deadEnd: g.deadEnd ?? true });
    assert.deepEqual(flat(scene, wall), g.expect);
  });
}

test('長さ 0 の壁は輪郭線を出さない', () => {
  const { scene, wall } = wallFixture([]);
  scene.nodes[wall.b].x = scene.nodes[wall.a].x;
  assert.deepEqual(wallOutline(scene, wall), []);
});

test('斜めの壁でも厚みの半分だけ法線方向にずれる', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(3000, 4000));
  const wall = addWall(scene, a, b, 100)!;
  const segments = wallOutline(scene, wall);
  // 法線は進行方向の左。(0.6, 0.8) の左は (-0.8, 0.6)
  const side = segments[0];
  assert.ok(Math.abs(side.a.x - -40) < 1e-9, `x = ${side.a.x}`);
  assert.ok(Math.abs(side.a.y - 30) < 1e-9, `y = ${side.a.y}`);
});

// --- 区間計算（3D の押し出しが使う） ---

import { wallPointAt, wallSpans } from '../src/core/shape.ts';

test('開口がなければ壁は1区間', () => {
  const { scene, wall } = wallFixture([]);
  const ws = wallSpans(scene, wall)!;
  assert.deepEqual(ws.spans, [[0, 4000]]);
  assert.deepEqual(ws.holes, []);
  assert.equal(ws.total, 4000);
  assert.equal(ws.thickness, 120);
});

test('中央の開口で2区間に割れる', () => {
  const { scene, wall } = wallFixture([[2000, 800]]);
  const ws = wallSpans(scene, wall)!;
  assert.deepEqual(ws.spans, [
    [0, 1600],
    [2400, 4000],
  ]);
  assert.equal(ws.holes.length, 1);
  assert.deepEqual([ws.holes[0].lo, ws.holes[0].hi], [1600, 2400]);
  assert.equal(ws.holes[0].opening.width, 800, '開口の実体が引けていない');
});

test('壁端をはみ出す開口は壁の中にクランプされる', () => {
  const { scene, wall } = wallFixture([[200, 1000]]);
  const ws = wallSpans(scene, wall)!;
  assert.deepEqual([ws.holes[0].lo, ws.holes[0].hi], [0, 700], '始点側がクランプされていない');
  assert.deepEqual(ws.spans, [[700, 4000]]);
});

test('壁を覆い尽くす開口では区間が残らない', () => {
  const { scene, wall } = wallFixture([[2000, 4000]]);
  const ws = wallSpans(scene, wall)!;
  assert.deepEqual(ws.spans, []);
  assert.deepEqual([ws.holes[0].lo, ws.holes[0].hi], [0, 4000]);
});

test('隣り合う開口で3区間になり、開口は位置の順に並ぶ', () => {
  const { scene, wall } = wallFixture([
    [2800, 600],
    [1200, 600],
  ]);
  const ws = wallSpans(scene, wall)!;
  // 仕込んだ順ではなく offset の昇順。spans のカーソル計算がこの並びを前提にしている
  assert.deepEqual(ws.holes.map((h) => h.lo), [900, 2500]);
  assert.deepEqual(ws.spans, [
    [0, 900],
    [1500, 2500],
    [3100, 4000],
  ]);
});

test('重なった開口はひとつながりの穴として扱われる', () => {
  const { scene, wall } = wallFixture([
    [1500, 1200],
    [2000, 1200],
  ]);
  const ws = wallSpans(scene, wall)!;
  assert.deepEqual(ws.spans, [
    [0, 900],
    [2600, 4000],
  ]);
});

test('長さ 0 の壁では null', () => {
  const { scene, wall } = wallFixture([]);
  scene.nodes[wall.b].x = scene.nodes[wall.a].x;
  assert.equal(wallSpans(scene, wall), null);
});

test('壁芯からの位置が輪郭線と同じ座標を返す', () => {
  const { scene, wall } = wallFixture([]);
  const ws = wallSpans(scene, wall)!;
  assert.deepEqual([wallPointAt(ws, 0, 0).x, wallPointAt(ws, 0, 0).y], [0, 0]);
  assert.deepEqual([wallPointAt(ws, 4000, 0).x, wallPointAt(ws, 4000, 0).y], [4000, 0]);
  assert.deepEqual([wallPointAt(ws, 1000, 1).x, wallPointAt(ws, 1000, 1).y], [1000, 60]);
  assert.deepEqual([wallPointAt(ws, 1000, -1).x, wallPointAt(ws, 1000, -1).y], [1000, -60]);
});

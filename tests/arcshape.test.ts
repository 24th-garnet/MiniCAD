import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, type Scene, type Wall } from '../src/core/types.ts';
import { addWall, findOrCreateNode, wallLength } from '../src/core/ops.ts';
import { dist, vec, type Vec } from '../src/core/geometry.ts';
import {
  openingFrame, openingJambs, openingQuad, wallOutline, wallQuad, wallSpans,
} from '../src/core/shape.ts';
import { buildMesh } from '../src/render3d/mesh.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { sceneToSvg } from '../src/io/svg.ts';
import { sceneToDxf } from '../src/io/dxf.ts';
import { defaultSettings } from '../src/core/store.ts';
import { makeOpening } from './make.ts';

/**
 * 円弧壁が見えるようになること。
 *
 * **直線の道は 1 字も変えていない**のが前提。平面も SVG も DXF も同じ
 * `wallPointAt` を通るので、ここが揺れると既存の図面の書き出しが全部動く。
 */

const R = 3000;
/** 四分円の膨らみ。tan(π/8) */
const QUARTER = Math.tan(Math.PI / 8);

/** 半径 3000 の四分円の壁 1 本 */
function arcWall(thickness = 200): { scene: Scene; wall: Wall } {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(R, R));
  const wall = addWall(scene, a, b, thickness, undefined, QUARTER)!;
  return { scene, wall };
}

/** 点の列が、中心から等しい距離にあるか */
const radii = (pts: Vec[], center: Vec): number[] => pts.map((p) => dist(p, center));

test('直線の壁の外形はこれまでと同じ 4 点', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const wall = addWall(scene, a, b, 200)!;
  assert.deepEqual(wallQuad(scene, wall), [
    { x: 0, y: 100 }, { x: 4000, y: 100 }, { x: 4000, y: -100 }, { x: 0, y: -100 },
  ]);
});

test('円弧の壁の外形は、内と外で半径が壁厚の半分だけ違う', () => {
  const t = 200;
  const { scene, wall } = arcWall(t);
  const ws = wallSpans(scene, wall)!;
  assert.ok(ws.arc, '円弧として持っていない');
  const center = ws.arc!.center;

  const quad = wallQuad(scene, wall);
  assert.ok(quad.length > 4, `折れ線になっていない（${quad.length} 点）`);
  const rs = radii(quad, center).sort((x, y) => x - y);
  // 内側は R−t/2、外側は R+t/2 のどちらか
  for (const r of rs) {
    assert.ok(
      Math.abs(r - (R - t / 2)) < 1e-6 || Math.abs(r - (R + t / 2)) < 1e-6,
      `半径 ${r} が内外どちらでもない`,
    );
  }
  assert.ok(Math.abs(rs[0] - (R - t / 2)) < 1e-6);
  assert.ok(Math.abs(rs[rs.length - 1] - (R + t / 2)) < 1e-6);
});

test('輪郭線も円弧に沿う——弦を一跨ぎにしない', () => {
  const { scene, wall } = arcWall();
  const segs = wallOutline(scene, wall);
  const ws = wallSpans(scene, wall)!;
  // 弦の長さ（R√2 ≒ 4243）を 1 本で跨ぐ線分があってはいけない
  const longest = Math.max(...segs.map((s) => dist(s.a, s.b)));
  assert.ok(longest < 1000, `${Math.round(longest)} mm の線分がある（弦を一跨ぎしている）`);
  // すべての端点が内外どちらかの円の上に乗る
  const center = ws.arc!.center;
  for (const s of segs) {
    for (const p of [s.a, s.b]) {
      const r = dist(p, center);
      assert.ok(
        Math.abs(r - (R - 100)) < 1e-6 || Math.abs(r - (R + 100)) < 1e-6,
        `輪郭の点が円の上に無い（半径 ${r}）`,
      );
    }
  }
});

test('弦より長い開口も、両端が円弧の上に乗る', () => {
  // 半径 3000 の四分円は弧長 4712mm。弦は 4243mm。幅 1600 の窓を真ん中に
  const { scene, wall } = arcWall();
  const op = makeOpening(wall.id, {
    kind: 'window', offset: wallLength(scene, wall) / 2, width: 1600,
  });
  scene.openings[op.id] = op;

  const frame = openingFrame(scene, op)!;
  const center = wallSpans(scene, wall)!.arc!.center;
  for (const p of [frame.start, frame.center, frame.end]) {
    assert.ok(Math.abs(dist(p, center) - R) < 1e-6, `開口の端が壁芯から外れている（${dist(p, center)}）`);
  }
  // 両端の法線は向きが違う（弦なら同じになる）
  assert.ok(
    Math.abs(frame.startNormal.x - frame.endNormal.x) > 0.1,
    '両端の法線が同じ向きになっている',
  );
});

test('小口はその位置の法線で引く——壁からはみ出さない', () => {
  const t = 200;
  const { scene, wall } = arcWall(t);
  const op = makeOpening(wall.id, {
    kind: 'window', offset: wallLength(scene, wall) / 2, width: 1600,
  });
  scene.openings[op.id] = op;
  const frame = openingFrame(scene, op)!;
  const center = wallSpans(scene, wall)!.arc!.center;

  for (const jamb of openingJambs(frame)) {
    for (const p of [jamb.a, jamb.b]) {
      const r = dist(p, center);
      assert.ok(
        Math.abs(r - (R - t / 2)) < 1e-6 || Math.abs(r - (R + t / 2)) < 1e-6,
        `小口の端が壁の面に乗っていない（半径 ${r}）`,
      );
    }
  }
});

test('穴の抜き型も曲がる——膨らんだぶんの壁が残らない', () => {
  const t = 200;
  const { scene, wall } = arcWall(t);
  const op = makeOpening(wall.id, {
    kind: 'window', offset: wallLength(scene, wall) / 2, width: 1600,
  });
  scene.openings[op.id] = op;
  const frame = openingFrame(scene, op)!;
  const quad = openingQuad(frame);
  assert.ok(quad.length > 4, `抜き型が四角のまま（${quad.length} 点）`);

  const center = wallSpans(scene, wall)!.arc!.center;
  // 抜き型は壁の内外を 1mm ずつ超える
  for (const p of quad) {
    const r = dist(p, center);
    assert.ok(
      Math.abs(r - (R - t / 2 - 1)) < 1e-6 || Math.abs(r - (R + t / 2 + 1)) < 1e-6,
      `抜き型の点が壁ぴったり 1mm 外に無い（半径 ${r}）`,
    );
  }
});

test('3D も刻んで積む——弦のまっすぐな箱にならない', () => {
  const { scene, wall } = arcWall();
  const faces = buildMesh(scene, detectRooms(scene)).filter(
    (f) => f.ref?.type === 'wall' && f.ref.id === wall.id,
  );
  // 四分円を ARC_STEP(π/16) で刻むと 8 つ。1 つの角柱なら面は 6 枚きり
  assert.ok(faces.length > 20, `3D の面が ${faces.length} 枚（刻んでいない）`);
});

test('SVG と DXF にも曲がりが出る', () => {
  const { scene } = arcWall();
  const rooms = detectRooms(scene);
  const svg = sceneToSvg(scene, rooms, defaultSettings());
  assert.ok(!/NaN|Infinity|undefined/.test(svg), 'SVG に不正な値がある');
  // 壁の外形は多角形 1 つ。4 点なら弦のまま
  const poly = /<polygon points="([^"]+)"/.exec(svg);
  assert.ok(poly, 'SVG に壁の外形が無い');
  assert.ok(poly![1].split(' ').length > 4, 'SVG の壁が四角のまま');

  const dxf = sceneToDxf(scene, rooms, defaultSettings(), {
    escapeUnicode: false, trueDimension: true,
  });
  const lines = (dxf.match(/\r\nLINE\r\n/g) ?? []).length;
  assert.ok(lines > 4, `DXF の線が ${lines} 本（折れ線になっていない）`);
  assert.ok(Object.keys(scene.walls).length === 1, '壁は 1 本のはず');
});

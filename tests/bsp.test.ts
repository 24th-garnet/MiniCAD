import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBsp, bspOrder, bspSize, splitFace } from '../src/render3d/bsp.ts';
import { extrudePrism, type Face3, type FaceSource } from '../src/render3d/mesh.ts';
import { rayFace, pickRay, type Ray3 } from '../src/render3d/ray.ts';
import { vec3, type Vec3 } from '../src/render3d/mat4.ts';
import { vec } from '../src/core/geometry.ts';

/**
 * 面を割る木（BSP、22 段）。
 *
 * **重心の深さで並べる方式は、互いに跨いだ 2 枚で必ず嘘になる。** 重心は面を
 * 1 点に潰すので、どちらを先に塗っても片方が間違う。面を割れば跨いだ組が
 * 無くなり、**どの視点からでも奥から手前に塗れる**。
 */

const SRC: FaceSource = { ref: null, levelId: 'L1' };

/** 中心と大きさから直方体の面を作る */
function box(cx: number, cy: number, cz: number, w: number, h: number, d: number): Face3[] {
  const out: Face3[] = [];
  extrudePrism(
    [vec(cx - w / 2, cy - h / 2), vec(cx + w / 2, cy - h / 2), vec(cx + w / 2, cy + h / 2), vec(cx - w / 2, cy + h / 2)],
    cz - d / 2, cz + d / 2, '#888', 'wall', SRC, out,
  );
  return out;
}

/** 平らな多角形の面積。ニューウェル法の面積ベクトルの長さの半分 */
function area(points: Vec3[]): number {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    x += a.y * b.z - a.z * b.y;
    y += a.z * b.x - a.x * b.z;
    z += a.x * b.y - a.y * b.x;
  }
  return Math.hypot(x, y, z) / 2;
}

const totalArea = (faces: readonly Face3[]): number => faces.reduce((s, f) => s + area(f.points), 0);

/** 木に入っている面を全部集める */
function allFaces(node: ReturnType<typeof buildBsp>): Face3[] {
  if (!node) return [];
  return [...node.on, ...allFaces(node.front), ...allFaces(node.back)];
}

test('空でも 1 枚でも落ちない', () => {
  assert.equal(buildBsp([]), null);
  assert.deepEqual(bspOrder(null, vec3(0, 0, 0)), []);
  const one = box(0, 0, 0, 100, 100, 100).slice(0, 1);
  assert.equal(bspSize(buildBsp(one)), 1);
});

test('割っても面積の合計が変わらない', () => {
  // **切り口が合っていないと面積が増えたり減ったりする。**
  // 交点を表と裏の両方の輪に入れることで、隙間も重なりも作らない
  const faces = [...box(0, 0, 0, 2000, 2000, 2000), ...box(900, 900, 900, 2000, 2000, 2000)];
  const before = totalArea(faces);
  const after = totalArea(allFaces(buildBsp(faces)));
  assert.ok(Math.abs(after - before) / before < 1e-9,
    `${before.toFixed(1)} → ${after.toFixed(1)}`);
});

test('割った断片は元の面を指す', () => {
  const faces = [...box(0, 0, 0, 2000, 2000, 2000), ...box(900, 900, 900, 2000, 2000, 2000)];
  const all = allFaces(buildBsp(faces));
  assert.ok(all.length > faces.length, '1 枚も割れていない');
  for (const f of all) {
    const source = f.origin ?? f;
    assert.ok(faces.includes(source), '元をたどれない断片がある');
    // 断片の法線は元のまま。細い切れ端から出し直すと向きが飛ぶ
    assert.deepEqual(f.normal, source.normal);
  }
});

test('平面に乗った面は割らず、またぐ面だけ割る', () => {
  const faces = box(0, 0, 0, 1000, 1000, 1000); // z は -500〜500

  // 上面とぴったり同じ高さ。乗っている 1 枚だけが `on`、残りは裏側へ
  const top = { front: [] as Face3[], back: [] as Face3[], on: [] as Face3[] };
  for (const f of faces) splitFace(f, { n: vec3(0, 0, 1), d: 500 }, top);
  assert.equal(top.on.length, 1, '上面が平面に乗っていると見なされない');
  assert.equal(top.front.length, 0, '上面より上に面がある');
  assert.equal(top.back.length, 5, '残り 5 枚が裏側に入っていない');
  assert.equal(top.back.filter((f) => f.origin).length, 0, 'またいでいないのに割られた');

  // 真ん中で割る。側面 4 枚がまたぐ
  const mid = { front: [] as Face3[], back: [] as Face3[], on: [] as Face3[] };
  for (const f of faces) splitFace(f, { n: vec3(0, 0, 1), d: 0 }, mid);
  assert.equal(mid.on.length, 0, '真ん中に乗る面は無いはず');
  assert.equal(mid.front.length, 5, '上半分が 5 枚でない');
  assert.equal(mid.back.length, 5, '下半分が 5 枚でない');
  assert.equal(mid.front.filter((f) => f.origin).length, 4, '側面 4 枚が割れていない');
  // 割った合計の面積は元のまま
  assert.ok(Math.abs(totalArea([...mid.front, ...mid.back]) - totalArea(faces)) < 1e-6,
    '割ると面積が変わる');
});

/**
 * 交差する 2 つの直方体を、36 方位 × 6 仰角から見る。
 *
 * **塗る順が正しければ、最後に塗られた面がいちばん手前にある。**
 * 画素に落とさず、視線 1 本ずつで同じことを見る。
 */
test('交差する 2 つの直方体は、どの視点からでも手前の面が後に描かれる', () => {
  const faces = [...box(0, 0, 0, 2000, 2000, 2000), ...box(900, 900, 900, 2000, 2000, 2000)];
  const tree = buildBsp(faces);
  const center = vec3(450, 450, 450);
  const reach = 20000;

  for (let i = 0; i < 36; i++) {
    const az = ((i * 10 + 3.7) * Math.PI) / 180;
    for (const deg of [-70, -40, -12, 12, 40, 70]) {
      const el = (deg * Math.PI) / 180;
      const dir = vec3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
      const eye = vec3(center.x + dir.x * reach, center.y + dir.y * reach, center.z + dir.z * reach);
      const ordered = bspOrder(tree, eye);

      // 視線を少しずらしながら何本か飛ばす
      for (const [du, dv] of [[0, 0], [300, 200], [-400, 150], [250, -350], [-200, -250]]) {
        const target = vec3(center.x + du, center.y + dv, center.z + (du - dv) / 3);
        const d = norm(vec3(target.x - eye.x, target.y - eye.y, target.z - eye.z));
        const ray: Ray3 = { origin: eye, direction: d };
        const truth = pickRay(ray, faces, 1);
        if (!truth) continue;

        // 塗る順にたどって、最後に当たった面＝画面に残る面
        let shown: { face: Face3; t: number } | null = null;
        for (const f of ordered) {
          const t = rayFace(ray, f, 1);
          if (t !== null) shown = { face: f, t };
        }
        assert.ok(shown, `方位 ${i * 10}° 仰角 ${deg}°: 何も塗られない`);
        assert.ok(Math.abs(shown.t - truth.t) < 1,
          `方位 ${i * 10}° 仰角 ${deg}°: 塗られたのが ${shown.t.toFixed(1)}mm、`
          + `本当に手前なのは ${truth.t.toFixed(1)}mm`);
      }
    }
  }
});

const norm = (v: Vec3): Vec3 => {
  const n = Math.hypot(v.x, v.y, v.z);
  return vec3(v.x / n, v.y / n, v.z / n);
};

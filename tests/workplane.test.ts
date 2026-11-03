import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  floorPlane, fromPlane, planeFromNormal, planeGridFaces, roundOnPlane, toPlane,
} from '../src/render3d/workplane.ts';
import { cross3, dot3, length3, sub3, vec3, type Vec3 } from '../src/render3d/mat4.ts';

/**
 * 作図面（19 段）。**3D の中で「どこに置くか」を決める 1 枚の面。**
 *
 * 要は「丸めは面の中の座標でやる」という一点で、これを間違えると
 * **傾いた面の上で格子が斜めに潰れる**（ワールドの x・y で丸めた場合）。
 */

const NORMALS: Vec3[] = [
  vec3(0, 0, 1),      // 床
  vec3(0, 0, -1),     // 天井
  vec3(1, 0, 0),      // 立った壁
  vec3(0, 1, 0),
  vec3(0.6, 0, 0.8),  // 傾いた面
  vec3(-0.5, 0.5, -0.707),
];

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

test('作図面の 2 軸は正規直交で、u × v が法線になる', () => {
  // ここが崩れると面の中の座標が歪み、格子が平行四辺形になる
  for (const n of NORMALS) {
    const plane = planeFromNormal(n, vec3(100, 200, 300), 'test');
    assert.ok(near(length3(plane.u), 1, 1e-9), 'u が単位ベクトルでない');
    assert.ok(near(length3(plane.v), 1, 1e-9), 'v が単位ベクトルでない');
    assert.ok(near(dot3(plane.u, plane.v), 0, 1e-9), 'u と v が直交していない');
    assert.ok(near(dot3(plane.u, plane.normal), 0, 1e-9), 'u が面の中に無い');
    assert.ok(near(dot3(plane.v, plane.normal), 0, 1e-9), 'v が面の中に無い');
    const c = cross3(plane.u, plane.v);
    assert.ok(length3(sub3(c, plane.normal)) < 1e-9, 'u × v が法線と一致しない');
  }
});

test('床の作図面は平面図と同じ向きの格子になる', () => {
  // 床の上の格子が 45 度傾いていたら、2D で描いたものと噛み合わない
  const plane = planeFromNormal(vec3(0, 0, 1), vec3(0, 0, 0), '床');
  assert.deepEqual(plane.u, vec3(1, 0, 0));
  assert.deepEqual(plane.v, vec3(0, 1, 0));
});

test('面の中の座標は往復する', () => {
  for (const n of NORMALS) {
    const plane = planeFromNormal(n, vec3(-500, 700, 1200), 'test');
    for (const uv of [{ u: 0, v: 0 }, { u: 300, v: -900 }, { u: -1234.5, v: 678.9 }]) {
      const back = toPlane(plane, fromPlane(plane, uv));
      assert.ok(near(back.u, uv.u, 1e-6) && near(back.v, uv.v, 1e-6), `${JSON.stringify(uv)} が戻らない`);
    }
  }
});

test('丸めた点は作図面の上に残り、面の中で格子に乗る', () => {
  // **ワールドの x・y で丸めると、傾いた面では点が面から浮く。**
  // 浮いた点に立体を置くと、見えている面から離れたところに出る
  const grid = 300;
  for (const n of NORMALS) {
    const plane = planeFromNormal(n, vec3(123, -456, 789), 'test');
    for (const p of [vec3(0, 0, 0), vec3(1000, 2000, 500), vec3(-700, 70, -70)]) {
      // いったん面の上へ落としてから丸める（面の外の点は丸めの対象ではない）
      const on = fromPlane(plane, toPlane(plane, p));
      const r = roundOnPlane(plane, on, grid);
      assert.ok(Math.abs(dot3(sub3(r, plane.origin), plane.normal)) < 1e-6, '面から浮いた');
      const uv = toPlane(plane, r);
      assert.ok(near(uv.u % grid, 0, 1e-6) || near(Math.abs(uv.u % grid), grid, 1e-6), 'u が格子に乗らない');
      assert.ok(near(uv.v % grid, 0, 1e-6) || near(Math.abs(uv.v % grid), grid, 1e-6), 'v が格子に乗らない');
    }
  }
});

test('刻みが 0 なら丸めない', () => {
  const plane = floorPlane(0);
  const p = vec3(123.4, -567.8, 0);
  assert.deepEqual(roundOnPlane(plane, p, 0), p);
});

test('格子は作図面の上に、桝目の数だけ敷かれる', () => {
  const half = 4;
  const step = 500;
  for (const n of NORMALS) {
    const plane = planeFromNormal(n, vec3(0, 0, 1000), 'test');
    const faces = planeGridFaces(plane, plane.origin, step, half, '#000', 'L1');
    // 縦横に (2·half+1) 本ずつ
    assert.equal(faces.length, (half * 2 + 1) * 2, '格子の本数が違う');
    for (const f of faces) {
      for (const p of f.points) {
        // 2mm だけ浮かせてある（床と同じ高さだと塗りの勝ち負けがちらつく）
        const d = dot3(sub3(p, plane.origin), plane.normal);
        assert.ok(Math.abs(d - 2) < 1e-6, `格子が面から ${d} ずれている`);
      }
      // **向きが逆だと `paint` が背面として落とす**（格子が丸ごと消える）
      assert.ok(length3(sub3(f.normal, plane.normal)) < 1e-6,
        `格子の法線が作図面と逆を向いている (${JSON.stringify(f.normal)})`);
      assert.equal(f.ref, null, '格子が実体を指している');
      // **`floor` にすると壁より先に塗られ、壁に敷いた格子が壁に隠れる**
      assert.equal(f.bucket, 'wall', '格子が壁や家具より先に塗られてしまう');
    }
  }
});

test('格子は中心を格子に乗せるので、カーソルで震えない', () => {
  const plane = floorPlane(0);
  const a = planeGridFaces(plane, vec3(10, 10, 0), 500, 2, '#000', 'L1');
  const b = planeGridFaces(plane, vec3(-10, -10, 0), 500, 2, '#000', 'L1');
  assert.deepEqual(a.map((f) => f.points), b.map((f) => f.points));
});

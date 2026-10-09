import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cross3,
  dot3,
  mat4Identity,
  mat4LookAt,
  mat4Multiply,
  mat4Ortho,
  mat4Perspective,
  mat4Translate,
  normalize3,
  transformPoint,
  vec3,
  type Mat4,
} from '../src/render3d/mat4.ts';

const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol;

test('平行移動が m[12], m[13], m[14] に入る（列優先の確認）', () => {
  // 行優先と取り違えるとここで即落ちる
  const m = mat4Translate(1, 2, 3);
  assert.equal(m[12], 1);
  assert.equal(m[13], 2);
  assert.equal(m[14], 3);
  const p = transformPoint(m, vec3(10, 20, 30));
  assert.deepEqual([p.x, p.y, p.z, p.w], [11, 22, 33, 1]);
});

test('単位行列との積が元に戻り、合成は後ろを先に適用する', () => {
  const m = mat4Translate(5, -2, 7);
  assert.deepEqual(mat4Multiply(m, mat4Identity()), m);
  assert.deepEqual(mat4Multiply(mat4Identity(), m), m);

  // a ∘ b は b を先に適用する
  const composed = mat4Multiply(mat4Translate(1, 0, 0), mat4Translate(0, 10, 0));
  const p = transformPoint(composed, vec3(0, 0, 0));
  assert.deepEqual([p.x, p.y, p.z], [1, 10, 0]);
});

test('lookAt が注視方向をカメラ空間の -z に写す', () => {
  const eye = vec3(1000, 2000, 1500);
  const target = vec3(0, 0, 0);
  const view = mat4LookAt(eye, target, vec3(0, 0, 1));

  const atEye = transformPoint(view, eye);
  assert.ok(near(atEye.x, 0, 1e-6) && near(atEye.y, 0, 1e-6) && near(atEye.z, 0, 1e-6), '視点が原点に来ない');

  const atTarget = transformPoint(view, target);
  assert.ok(near(atTarget.x, 0, 1e-6) && near(atTarget.y, 0, 1e-6), '注視点が中心に来ない');
  assert.ok(atTarget.z < 0, `注視点が -z 側にない: ${atTarget.z}`);
  assert.ok(near(Math.abs(atTarget.z), Math.hypot(1000, 2000, 1500), 1e-6), '距離が保たれていない');
});

test('lookAt が視点と注視点が同じでも NaN を出さない', () => {
  const view = mat4LookAt(vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 1));
  for (const v of view) assert.ok(Number.isFinite(v), '行列に非有限値が入った');
});

test('透視投影で near が NDC の -1、far が +1 に写る', () => {
  const [n, f] = [10, 100000];
  const m = mat4Perspective(Math.PI / 4, 1.5, n, f);
  const atNear = transformPoint(m, vec3(0, 0, -n));
  const atFar = transformPoint(m, vec3(0, 0, -f));
  assert.ok(near(atNear.z / atNear.w, -1, 1e-9), `near: ${atNear.z / atNear.w}`);
  assert.ok(near(atFar.z / atFar.w, 1, 1e-9), `far: ${atFar.z / atFar.w}`);
  // 透視では w はカメラ空間 z の符号反転
  assert.ok(near(atNear.w, n));
});

test('透視投影で画角の端が NDC の ±1 に来る', () => {
  const fov = Math.PI / 3;
  const aspect = 2;
  const m = mat4Perspective(fov, aspect, 10, 100000);
  const z = -1000;
  const halfH = Math.tan(fov / 2) * 1000;
  const top = transformPoint(m, vec3(0, halfH, z));
  const right = transformPoint(m, vec3(halfH * aspect, 0, z));
  assert.ok(near(top.y / top.w, 1, 1e-9), `上端 ${top.y / top.w}`);
  assert.ok(near(right.x / right.w, 1, 1e-9), `右端 ${right.x / right.w}`);
});

test('平行投影では w が常に 1 で、距離によらず大きさが変わらない', () => {
  const m = mat4Ortho(1000, 500, 10, 100000);
  const nearPoint = transformPoint(m, vec3(1000, 0, -100));
  const farPoint = transformPoint(m, vec3(1000, 0, -50000));
  assert.equal(nearPoint.w, 1);
  assert.equal(farPoint.w, 1);
  assert.ok(near(nearPoint.x, farPoint.x), '距離で大きさが変わっている');
});

test('透視では近いものほど大きく写る', () => {
  const m = mat4Perspective(Math.PI / 4, 1, 10, 100000);
  const screenX = (z: number) => {
    const p = transformPoint(m, vec3(1000, 0, z));
    return Math.abs(p.x / p.w);
  };
  assert.ok(screenX(-1000) > screenX(-5000), '遠いほうが大きい');
});

test('投影の種類を変えても、カメラ空間 z の前後関係は一致する', () => {
  // 深度ソートのキーを射影前の z に取ってよい根拠
  const persp = mat4Perspective(Math.PI / 4, 1.5, 10, 100000);
  const ortho = mat4Ortho(2000, 1300, 10, 100000);
  const pairs: [number, number][] = [
    [-100, -200],
    [-1000, -50000],
    [-30, -31],
  ];
  for (const [za, zb] of pairs) {
    const order = (m: Mat4) => {
      const a = transformPoint(m, vec3(0, 0, za));
      const b = transformPoint(m, vec3(0, 0, zb));
      return Math.sign(a.z / a.w - b.z / b.w);
    };
    assert.equal(order(persp), order(ortho), `z = ${za} と ${zb} で前後が食い違う`);
    assert.equal(order(persp), Math.sign(zb - za), 'カメラ空間 z の順と一致しない');
  }
});

test('ベクトル演算の小物', () => {
  assert.deepEqual(cross3(vec3(1, 0, 0), vec3(0, 1, 0)), vec3(0, 0, 1));
  assert.equal(dot3(vec3(1, 2, 3), vec3(4, 5, 6)), 32);
  assert.deepEqual(normalize3(vec3(0, 0, 0)), vec3(0, 0, 1), '長さ0は既定に落ちる');
  assert.deepEqual(normalize3(vec3(0, 0, 0), vec3(1, 0, 0)), vec3(1, 0, 0));
  const n = normalize3(vec3(3, 4, 0));
  assert.ok(near(n.x, 0.6) && near(n.y, 0.8));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPoint,
  compose,
  directionAngleAfter,
  IDENTITY,
  isMirror,
  mirror,
  rotation,
  scaleOf,
  translation,
  type Transform,
} from '../src/core/transform.ts';
import { toDeg, toRad, vec, type Vec } from '../src/core/geometry.ts';

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const nearPt = (a: Vec, b: Vec, eps = 1e-9) => near(a.x, b.x, eps) && near(a.y, b.y, eps);
const show = (p: Vec) => `(${p.x}, ${p.y})`;

test('平行移動は座標をずらすだけ', () => {
  const t = translation(vec(100, -50));
  assert.ok(nearPt(applyPoint(t, vec(10, 20)), vec(110, -30)));
  assert.equal(isMirror(t), false);
  assert.ok(near(scaleOf(t), 1));
});

test('回転の中心は動かない', () => {
  const center = vec(1000, 2000);
  const t = rotation(center, toRad(37));
  assert.ok(nearPt(applyPoint(t, center), center, 1e-6), show(applyPoint(t, center)));
});

test('原点まわりの90度回転', () => {
  const t = rotation(vec(0, 0), Math.PI / 2);
  assert.ok(nearPt(applyPoint(t, vec(100, 0)), vec(0, 100), 1e-9), show(applyPoint(t, vec(100, 0))));
});

test('90度回転を4回で元に戻る', () => {
  const t = rotation(vec(500, 300), Math.PI / 2);
  const four = compose(compose(t, t), compose(t, t));
  const p = vec(1234, -567);
  assert.ok(nearPt(applyPoint(four, p), p, 1e-9), show(applyPoint(four, p)));
});

test('鏡像は行列式が負で、2回で元に戻る', () => {
  const t = mirror(vec(0, 0), vec(1, 1));
  assert.equal(isMirror(t), true);
  assert.ok(near(scaleOf(t), 1));
  const p = vec(300, 100);
  // y=x 軸の鏡像は x と y を入れ替える
  assert.ok(nearPt(applyPoint(t, p), vec(100, 300), 1e-9), show(applyPoint(t, p)));
  assert.ok(nearPt(applyPoint(compose(t, t), p), p, 1e-9));
});

test('鏡像の軸上の点は動かない', () => {
  const a = vec(100, 100);
  const b = vec(400, 700);
  const t = mirror(a, b);
  assert.ok(nearPt(applyPoint(t, a), a, 1e-6));
  assert.ok(nearPt(applyPoint(t, b), b, 1e-6));
});

test('向きの変換が回転でも鏡像でも正しい', () => {
  const rot = rotation(vec(0, 0), toRad(30));
  assert.ok(near(toDeg(directionAngleAfter(rot, toRad(10))), 40, 1e-9));

  // 水平な軸の鏡像では、角度は符号が反転する
  const flip = mirror(vec(0, 0), vec(1, 0));
  assert.ok(near(toDeg(directionAngleAfter(flip, toRad(30))), -30, 1e-9));
  // 45度の軸では 30度 -> 60度 (2*45 - 30)
  const diagonal = mirror(vec(0, 0), vec(1, 1));
  assert.ok(near(toDeg(directionAngleAfter(diagonal, toRad(30))), 60, 1e-9));
});

test('恒等変換は何も変えない', () => {
  const p = vec(42, -7);
  assert.ok(nearPt(applyPoint(IDENTITY, p), p));
  assert.equal(isMirror(IDENTITY), false);
});

test('潰れた軸の鏡像は恒等変換に落ちる', () => {
  const t: Transform = mirror(vec(5, 5), vec(5, 5));
  assert.deepEqual(t, IDENTITY);
});

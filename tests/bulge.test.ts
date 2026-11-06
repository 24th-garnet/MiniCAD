import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arcFromBulge,
  bulgeArcLength,
  bulgeFromThree,
  closestOnArc,
  dist,
  pointOnBulgeArc,
  vec,
} from '../src/core/geometry.ts';

/**
 * 膨らみで表す円弧（23 段）。円弧壁の土台。
 *
 * **中心を持たないのが肝。** 端点を動かしても必ず筋の通った円弧になる
 * ——中心を覚えると、動かした瞬間に「中心が弦の垂直二等分線の上に無い」
 * 矛盾した円弧になる。
 */

const A = vec(0, 0);
const B = vec(1000, 0);
const near = (x: number, y: number, why: string): void =>
  assert.ok(Math.abs(x - y) < 1e-6, `${why}: ${x} ≠ ${y}`);

test('膨らみ 1 は半円（右へ膨らむ）', () => {
  const arc = arcFromBulge(A, B, 1);
  assert.ok(arc, '円弧にならない');
  near(arc.center.x, 500, '中心 x');
  near(arc.center.y, 0, '中心 y');
  near(arc.radius, 500, '半径');
  near(arc.sweep, Math.PI, '掃過角');
  near(bulgeArcLength(arc), Math.PI * 500, '弧長');
  // **真ん中は下。** 反時計回りは中心が左にあるので、弧は右へ膨らむ
  near(pointOnBulgeArc(arc, 0.5).y, -500, '頂点');
});

test('膨らみが負なら左へ膨らむ', () => {
  const arc = arcFromBulge(A, B, -1)!;
  near(arc.sweep, -Math.PI, '掃過角の符号');
  near(pointOnBulgeArc(arc, 0.5).y, 500, '頂点');
  near(bulgeArcLength(arc), Math.PI * 500, '弧長は同じ');
});

test('膨らみ 0 は直線（円弧にしない）', () => {
  assert.equal(arcFromBulge(A, B, 0), null);
  assert.equal(arcFromBulge(A, B, 1e-12), null);
  assert.equal(arcFromBulge(A, A, 1), null, '長さの無い弦');
});

test('端点はいつも端点のまま', () => {
  for (const bulge of [0.2, 1, 2.5, -0.7]) {
    const arc = arcFromBulge(A, B, bulge)!;
    const a = pointOnBulgeArc(arc, 0);
    const b = pointOnBulgeArc(arc, 1);
    assert.ok(dist(a, A) < 1e-6, `${bulge}: 始点がずれた`);
    assert.ok(dist(b, B) < 1e-6, `${bulge}: 終点がずれた`);
  }
});

test('膨らみが 1 を超えると優弧になる（中心が弦の向こう側）', () => {
  const arc = arcFromBulge(A, B, 2)!;
  assert.ok(arc.sweep > Math.PI, `掃過角が π 以下 (${arc.sweep})`);
  // **優弧では中心が膨らむ側に入る。** 劣弧では反対側にある。
  // 膨らみ 2・弦 1000 なら 半径 625・中心 (500, -375)・いちばん出るのは y=-1000
  // ——矢高 1000 ＝ 弦の半分 × 2 で、膨らみの定義どおり
  assert.ok(arc.center.y < 0, `中心が膨らむ側に無い (${arc.center.y})`);
  near(arc.radius, 625, '半径');
  near(pointOnBulgeArc(arc, 0.5).y, -1000, '矢高');
  assert.ok(bulgeArcLength(arc) > Math.PI * arc.radius, '弧長が半周以下');
});

test('弧長は弦より長い', () => {
  for (const bulge of [0.1, 0.5, 1, 3]) {
    const arc = arcFromBulge(A, B, bulge)!;
    assert.ok(bulgeArcLength(arc) > 1000, `${bulge}: 弧長が弦以下`);
  }
});

test('3 点から出した膨らみが、その 3 点を通る円弧になる', () => {
  // **これが本題。** 描く入口は 3 クリックなので、ここが狂うと全部狂う
  for (const via of [vec(500, 300), vec(500, -300), vec(500, 900), vec(200, 400)]) {
    const bulge = bulgeFromThree(A, via, B);
    assert.notEqual(bulge, 0, `${JSON.stringify(via)}: 直線になった`);
    const arc = arcFromBulge(A, B, bulge)!;
    // 通る点が円弧の上にあるか（半径が合って、掃過の範囲に入っている）
    const got = closestOnArc(via, arc);
    assert.ok(got.dist < 1e-6, `${JSON.stringify(via)}: 通る点から ${got.dist}mm 離れた`);
  }
});

test('一直線なら膨らみは 0', () => {
  assert.equal(bulgeFromThree(A, vec(500, 0), B), 0);
  assert.equal(bulgeFromThree(A, vec(1500, 0), B), 0, '外側でも直線');
});

test('近い点は円弧の上、遠い点は端点に落ちる', () => {
  const arc = arcFromBulge(A, B, 1)!; // 下半分の半円
  // 真下は円弧の頂点
  const low = closestOnArc(vec(500, -900), arc);
  near(low.t, 0.5, '頂点の媒介変数');
  near(low.dist, 400, '頂点までの距離');
  // 真上は円弧の外。近いほうの端点に落ちる
  const above = closestOnArc(vec(-200, 50), arc);
  assert.ok(above.t === 0 || above.t === 1, `端点に落ちていない (t=${above.t})`);
  near(above.point.x, 0, '始点に落ちる');
  // 中心はどこでも等距離。t が範囲内であればよい
  const center = closestOnArc(arc.center, arc);
  near(center.dist, 500, '中心からは半径');
});

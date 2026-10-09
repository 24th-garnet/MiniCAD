import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arcContainsAngle,
  arcSweepAngle,
  circleCircleIntersection,
  lineCircleIntersection,
  lineLineIntersection,
  offsetPolyline,
  offsetSegment,
  projectParam,
  sideOfLine,
  toRad,
  vec,
  type Arc,
  type Vec,
} from '../src/core/geometry.ts';
import { curveIntersections, extendCurve, trimCurve, type Curve } from '../src/core/modify.ts';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const nearPt = (a: Vec, b: Vec, eps = 1e-6) => near(a.x, b.x, eps) && near(a.y, b.y, eps);
const seg = (ax: number, ay: number, bx: number, by: number): Curve => ({ kind: 'segment', a: vec(ax, ay), b: vec(bx, by) });

test('無限直線の交点は線分の外も返す', () => {
  const hit = lineLineIntersection(vec(0, 0), vec(10, 0), vec(20, -10), vec(20, 10))!;
  assert.ok(hit);
  assert.ok(nearPt(hit.point, vec(20, 0)));
  assert.ok(hit.t > 1, '線分の外なのに t が 0..1 に収まっている');
});

test('平行な直線には交点が無い', () => {
  assert.equal(lineLineIntersection(vec(0, 0), vec(10, 0), vec(0, 5), vec(10, 5)), null);
  // ほぼ平行なものも弾く（遠くに飛んだ点を返しても使い道がない）
  assert.equal(lineLineIntersection(vec(0, 0), vec(1e6, 0), vec(0, 5), vec(1e6, 5 + 1e-9)), null);
});

test('同一直線上の2線分は交点を1つに決められない', () => {
  assert.equal(lineLineIntersection(vec(0, 0), vec(10, 0), vec(5, 0), vec(20, 0)), null);
});

test('直線と円の交点は 0 / 1 / 2 本', () => {
  const c = vec(0, 0);
  assert.equal(lineCircleIntersection(vec(-10, 20), vec(10, 20), c, 10).length, 0, '離れている');
  const tangent = lineCircleIntersection(vec(-10, 10), vec(10, 10), c, 10);
  assert.equal(tangent.length, 1, '接線は1点');
  assert.ok(nearPt(tangent[0].point, vec(0, 10)));
  assert.equal(lineCircleIntersection(vec(-20, 0), vec(20, 0), c, 10).length, 2);
});

test('円どうしの交点', () => {
  assert.equal(circleCircleIntersection(vec(0, 0), 10, vec(100, 0), 10).length, 0, '離れている');
  assert.equal(circleCircleIntersection(vec(0, 0), 10, vec(20, 0), 10).length, 1, '外接は1点');
  assert.equal(circleCircleIntersection(vec(0, 0), 10, vec(10, 0), 10).length, 2);
  assert.equal(circleCircleIntersection(vec(0, 0), 10, vec(0, 0), 5).length, 0, '同心円');
});

test('±π の継ぎ目をまたぐ円弧でも範囲判定が正しい', () => {
  // 170° から -170°（＝190°）へ反時計回り。掃き角は 20°
  const arc: Arc = { center: vec(0, 0), radius: 100, start: toRad(170), end: toRad(-170) };
  assert.ok(near(arcSweepAngle(arc), toRad(20), 1e-9), `掃き角 ${arcSweepAngle(arc)}`);
  assert.equal(arcContainsAngle(arc, toRad(180)), true, '継ぎ目の上が入っていない');
  assert.equal(arcContainsAngle(arc, toRad(-180)), true, '-180 は 180 と同じ');
  assert.equal(arcContainsAngle(arc, toRad(175)), true);
  assert.equal(arcContainsAngle(arc, toRad(0)), false, '範囲外を入っていると判定している');
  assert.equal(arcContainsAngle(arc, toRad(160)), false);
});

test('始点と終点が同じ円弧は全周とみなす', () => {
  const arc: Arc = { center: vec(0, 0), radius: 10, start: 0, end: 0 };
  assert.ok(near(arcSweepAngle(arc), Math.PI * 2));
  assert.equal(arcContainsAngle(arc, toRad(123)), true);
});

test('線分のオフセットは進行方向の左が正', () => {
  const [a, b] = offsetSegment(vec(0, 0), vec(100, 0), 10);
  assert.ok(nearPt(a, vec(0, 10)) && nearPt(b, vec(100, 10)));
});

test('閉じた矩形を内側にオフセットすると各辺が 2d 縮む', () => {
  const rect = [vec(0, 0), vec(1000, 0), vec(1000, 600), vec(0, 600)];
  // 反時計回りの矩形では、内側は進行方向の左
  const inner = offsetPolyline(rect, 100, true)!;
  assert.ok(inner);
  assert.equal(inner.length, 4);
  assert.ok(nearPt(inner[0], vec(100, 100)), JSON.stringify(inner[0]));
  assert.ok(nearPt(inner[2], vec(900, 500)), JSON.stringify(inner[2]));
});

test('開いたポリラインのオフセットは端点が素直に寄る', () => {
  const pts = [vec(0, 0), vec(100, 0), vec(100, 100)];
  const out = offsetPolyline(pts, 10, false)!;
  assert.equal(out.length, 3);
  assert.ok(nearPt(out[0], vec(0, 10)));
  assert.ok(nearPt(out[1], vec(90, 10)), JSON.stringify(out[1]));
});

test('退化したポリラインはオフセットできない', () => {
  assert.equal(offsetPolyline([vec(0, 0)], 10, false), null);
  assert.equal(offsetPolyline([vec(0, 0), vec(0, 0)], 10, false), null);
});

test('射影パラメータはクランプしない', () => {
  assert.ok(near(projectParam(vec(0, 0), vec(100, 0), vec(150, 50)), 1.5));
  assert.ok(near(projectParam(vec(0, 0), vec(100, 0), vec(-50, 0)), -0.5));
});

test('直線のどちら側か', () => {
  assert.equal(sideOfLine(vec(0, 0), vec(100, 0), vec(50, 10)), 1);
  assert.equal(sideOfLine(vec(0, 0), vec(100, 0), vec(50, -10)), -1);
});

test('十字に交わる2直線のトリム', () => {
  const horizontal = seg(-100, 0, 100, 0);
  const vertical = seg(0, -100, 0, 100);

  // 左半分をクリックすると、左が消えて右が残る
  const left = trimCurve(horizontal, [vertical], vec(-50, 0))!;
  assert.equal(left.length, 1);
  assert.equal(left[0].kind, 'segment');
  if (left[0].kind === 'segment') {
    assert.ok(nearPt(left[0].a, vec(0, 0)) && nearPt(left[0].b, vec(100, 0)));
  }

  // 右半分をクリックすると逆
  const right = trimCurve(horizontal, [vertical], vec(50, 0))!;
  assert.equal(right.length, 1);
  if (right[0].kind === 'segment') {
    assert.ok(nearPt(right[0].a, vec(-100, 0)) && nearPt(right[0].b, vec(0, 0)));
  }
});

test('2本で切ると真ん中が落ちて2本残る', () => {
  const target = seg(-100, 0, 100, 0);
  const cutters = [seg(-50, -10, -50, 10), seg(50, -10, 50, 10)];
  const pieces = trimCurve(target, cutters, vec(0, 0))!;
  assert.equal(pieces.length, 2);
});

test('交差しないときのトリムは何もしない', () => {
  assert.equal(trimCurve(seg(0, 0, 100, 0), [seg(0, 50, 100, 50)], vec(50, 0)), null);
});

test('同じところを2回トリムしても2回目は何も起きない', () => {
  const target = seg(-100, 0, 100, 0);
  const cutter = seg(0, -100, 0, 100);
  const first = trimCurve(target, [cutter], vec(-50, 0))!;
  assert.ok(first);
  // 残った右半分の、さらに左側（＝交点上）をクリックしても切るところがない
  assert.equal(trimCurve(first[0], [cutter], vec(50, 0)), null);
});

test('延長は一番近い境界まで伸びる', () => {
  const target = seg(0, 0, 100, 0);
  const near1 = seg(200, -50, 200, 50);
  const far = seg(500, -50, 500, 50);
  const extended = extendCurve(target, [far, near1], vec(100, 0))!;
  assert.ok(extended);
  assert.equal(extended.kind, 'segment');
  if (extended.kind === 'segment') {
    assert.ok(nearPt(extended.a, vec(0, 0)), '伸ばさない側が動いている');
    assert.ok(nearPt(extended.b, vec(200, 0)), `${JSON.stringify(extended.b)}`);
  }
});

test('反対の端をクリックすればそちらが伸びる', () => {
  const target = seg(0, 0, 100, 0);
  const boundary = seg(-200, -50, -200, 50);
  const extended = extendCurve(target, [boundary], vec(0, 0))!;
  assert.ok(extended);
  if (extended.kind === 'segment') {
    assert.ok(nearPt(extended.a, vec(-200, 0)));
    assert.ok(nearPt(extended.b, vec(100, 0)), '伸ばさない側が動いている');
  }
});

test('伸ばす先に境界が無ければ何もしない', () => {
  // 境界が手前にあるだけなら伸ばせない
  assert.equal(extendCurve(seg(0, 0, 100, 0), [seg(50, -50, 50, 50)], vec(100, 0)), null);
});

test('円は延長できない', () => {
  const circle: Curve = { kind: 'circle', center: vec(0, 0), radius: 100 };
  assert.equal(extendCurve(circle, [seg(-200, 0, 200, 0)], vec(100, 0)), null);
});

test('円を2点で切ると円弧が残る', () => {
  const circle: Curve = { kind: 'circle', center: vec(0, 0), radius: 100 };
  const cutter = seg(-200, 0, 200, 0);
  const pieces = trimCurve(circle, [cutter], vec(0, 100))!;
  assert.ok(pieces);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].kind, 'arc');
  if (pieces[0].kind === 'arc') {
    // 上半分を消したので、残りは下半分（180度）
    assert.ok(near(arcSweepAngle(pieces[0].arc), Math.PI, 1e-6), `${arcSweepAngle(pieces[0].arc)}`);
  }
});

test('曲線どうしの交点は、既定では実体の上だけを返す', () => {
  const target = seg(0, 0, 100, 0);
  const beyond = seg(200, -50, 200, 50);
  assert.equal(curveIntersections(target, beyond).length, 0, '線分の外を拾っている');
  assert.equal(curveIntersections(target, beyond, true).length, 1, '無限直線としては交わる');
});

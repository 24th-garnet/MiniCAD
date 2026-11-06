import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arcContainsAngle,
  arcFromChordAndLength,
  arcSweepAngle,
  angleOf,
  centerFromTangent,
  dist,
  sub,
  vec,
  type Arc,
  type Vec,
} from '../src/core/geometry.ts';
import { arcThrough } from '../src/core/shapes.ts';
import { ShapeTool } from '../src/tools/shape.ts';

/**
 * 円弧の描き方（22 段）。ワイヤー 7 枚目「円弧　(7種類の描き方から選んで描く
 * ことが可能)」。**内訳は書かれていない**ので、数も中身も一致する
 * Vectorworks の円弧ツールの 7 モードから採った。
 */

const A = vec(0, 0);
const B = vec(1000, 0);

/** `ArcShape` の角の呼び名（startAngle / endAngle）を `Arc`（start / end）へ */
const asArc = (a: {
  center: Vec; radius: number; startAngle: number; endAngle: number;
}): Arc => ({ center: a.center, radius: a.radius, start: a.startAngle, end: a.endAngle });

/** 円弧の上に乗っているか。半径が合っていて、掃過の範囲に入っている */
const onArc = (
  a: { center: Vec; radius: number; startAngle: number; endAngle: number },
  p: Vec,
): boolean =>
  Math.abs(dist(a.center, p) - a.radius) < 1e-6 &&
  arcContainsAngle(asArc(a), angleOf(sub(p, a.center)));

test('円弧の描き方が、情報の違う 5 通りそろっている', () => {
  // **数合わせをしない。** 仕様の「7 種類」は Vectorworks の 7 モードだが、
  // そのうち 2 組は**クリックの順番が違うだけ**で、決まる円弧は同じ。
  //
  //   Radius（中心→始点）と Center（2 点→中心） → 中心・始点・終点
  //   Three Points（3 点）と Point on Arc（両端＋通過点） → 3 点を通る
  //
  // 同じものを 2 つ並べても使う人は迷うだけなので、情報の違う 5 通りに
  // まとめた（＋円）。**足りないものがあれば、ここが落ちる。**
  const tool = new ShapeTool('arc', 'arc', '円・弧', 'C');
  const how = (tool.options?.() ?? []).find(
    (f): f is Extract<typeof f, { kind: 'select' }> => f.kind === 'select' && f.label === '描き方',
  );
  assert.ok(how, '「描き方」が出ていない');
  assert.deepEqual(
    how.options.map((o) => o.value),
    ['circle', 'arc', 'three', 'chord', 'tangent', 'length'],
    '描き方の顔ぶれが変わった',
  );
});

test('接線の向きを指すと、その向きに出ていく円弧になる', () => {
  // (0,0) から真上へ出て (1000,0) に着く＝上半分の半円
  const center = centerFromTangent(A, B, vec(0, 1));
  assert.ok(center, '中心が出ない');
  assert.ok(Math.abs(center.x - 500) < 1e-6 && Math.abs(center.y) < 1e-6,
    `中心が違う ${JSON.stringify(center)}`);
  const arc = arcThrough(A, vec(500, 500), B)!;
  assert.ok(onArc(arc, vec(500, 500)), '上に膨らんでいない');
  assert.ok(!onArc(arc, vec(500, -500)), '下にも乗っている');
});

test('接線が弦と平行なら断る（円弧にならない）', () => {
  // 弦と同じ向きを接線にすると、中心を決める 2 直線が交わらない
  assert.equal(centerFromTangent(A, B, vec(1, 0)), null);
  assert.equal(centerFromTangent(A, B, vec(-1, 0)), null);
  // 長さの無い向きも断る
  assert.equal(centerFromTangent(A, B, vec(0, 0)), null);
});

test('弧長から出した半径で、弧の長さが注文どおりになる', () => {
  for (const want of [1100, 1200, 1570.796, 2000, 3000]) {
    const got = arcFromChordAndLength(1000, want);
    assert.ok(got, `${want}mm が解けない`);
    // 弧長 = 半径 × 中心角。中心角は半角の 2 倍
    const length = got.radius * got.half * 2;
    assert.ok(Math.abs(length - want) < 1e-6, `${want}mm のはずが ${length}`);
    // 弦は注文どおり
    const chord = 2 * got.radius * Math.sin(got.half);
    assert.ok(Math.abs(chord - 1000) < 1e-6, `弦が 1000 でない (${chord})`);
  }
});

test('半円はちょうど半径が弦の半分になる', () => {
  // 弧長が π×500 なら、半径 500 の半円
  const got = arcFromChordAndLength(1000, Math.PI * 500)!;
  assert.ok(Math.abs(got.radius - 500) < 1e-6, `半径が 500 でない (${got.radius})`);
  assert.ok(Math.abs(got.half - Math.PI / 2) < 1e-9, '半角が直角でない');
});

test('弧長が弦以下なら断る', () => {
  assert.equal(arcFromChordAndLength(1000, 1000), null, '同じ長さは直線');
  assert.equal(arcFromChordAndLength(1000, 900), null, '弦より短い弧は無い');
  assert.equal(arcFromChordAndLength(0, 1000), null, '弦が無い');
});

test('弧長で描いた円弧の長さが、実際の図形でも合っている', () => {
  // **ここが本題。** 半径だけ合っていても、掃過が逆向きなら長さが変わる
  const got = arcFromChordAndLength(1000, 2000)!;
  const rise = got.radius * (1 - Math.cos(got.half));
  const arc = arcThrough(A, vec(500, rise), B)!;
  const length = arc.radius * arcSweepAngle(asArc(arc));
  assert.ok(Math.abs(length - 2000) < 1e-6, `弧長が 2000 でない (${length}）`);
});

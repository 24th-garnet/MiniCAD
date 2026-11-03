import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arcContainsAngle,
  dist,
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

/**
 * 四角形も曲線も**折れ線に落とす**。`src/core/shapes.ts` のコメント自身が
 * 「矩形や多角形は `closed: true` で表す（専用の型は作らない）」と宣言していて、
 * 置いたあとに直せる値も「頂点を動かす」以外に無い。
 * 型・幾何・スナップ・入出力は既にあるので、足したのは描く導線だけ。
 */
test('対角 2 点から四角形の 4 隅が出る', async () => {
  const { rectFromDiagonal } = await import('../src/core/geometry.ts');
  const got = rectFromDiagonal(vec(0, 0), vec(3000, 2000));
  assert.deepEqual(got?.map((p) => [p.x, p.y]), [[0, 0], [3000, 0], [3000, 2000], [0, 2000]]);

  // 逆向きに取っても 4 隅は同じ場所に出る（並びは打った順に沿う）
  const back = rectFromDiagonal(vec(3000, 2000), vec(0, 0));
  assert.deepEqual(
    new Set(back?.map((p) => `${p.x},${p.y}`)),
    new Set(got?.map((p) => `${p.x},${p.y}`)),
  );
});

test('潰れた四角形は作らない', async () => {
  const { rectFromDiagonal } = await import('../src/core/geometry.ts');
  assert.equal(rectFromDiagonal(vec(0, 0), vec(0, 2000)), null, '幅 0 の四角形ができた');
  assert.equal(rectFromDiagonal(vec(0, 0), vec(3000, 0)), null, '高さ 0 の四角形ができた');
  assert.equal(rectFromDiagonal(vec(0, 0), vec(0.5, 2000)), null, '幅 0.5mm の四角形ができた');
});

test('自由曲線は打った点の上を通り、点より細かい折れ線になる', async () => {
  const { splinePoints } = await import('../src/core/geometry.ts');
  const control = [vec(0, 0), vec(1000, 1000), vec(2000, 0), vec(3000, 1000)];
  const got = splinePoints(control);

  assert.ok(got.length > control.length * 4, `細かくなっていない (${got.length})`);
  // **制御点そのものを通る**（Catmull-Rom。ベジエと違って引っぱられない）
  for (const c of control) {
    assert.ok(
      got.some((p) => dist(p, c) < 1e-6),
      `制御点 (${c.x},${c.y}) の上を通っていない`,
    );
  }
  // 始点と終点は制御点そのもの
  assert.ok(dist(got[0], control[0]) < 1e-6);
  assert.ok(dist(got[got.length - 1], control[control.length - 1]) < 1e-6);
});

test('制御点が 2 つ以下なら、曲げようがないのでそのまま返す', async () => {
  const { splinePoints } = await import('../src/core/geometry.ts');
  assert.equal(splinePoints([vec(0, 0), vec(1000, 0)]).length, 2);
  assert.equal(splinePoints([vec(0, 0)]).length, 1);
  assert.equal(splinePoints([]).length, 0);
});

/**
 * 円弧・楕円を折れ線に落とす式は **`core/geometry.ts` の 1 箇所**にある。
 * 以前は `core/shapes.ts` と `io/dxfImport.ts` に同じものが 1 つずつあり、
 * 刻みを変えると図形と DXF 取り込みで滑らかさが食い違った。
 */
test('楕円の折れ線は、全周なら始点を重ねない', async () => {
  const { ellipsePoints, ARC_STEP } = await import('../src/core/geometry.ts');
  const full = ellipsePoints(vec(0, 0), 1000, 0.5, 0);
  assert.equal(Math.round(Math.PI * 2 / ARC_STEP), full.length, '刻みと点の数が合わない');
  assert.ok(dist(full[0], full[full.length - 1]) > 1, '始点と終点が重なっている');

  // 弧なら両端を持つ
  const arc = ellipsePoints(vec(0, 0), 1000, 0.5, 0, 0, Math.PI);
  assert.ok(dist(arc[0], vec(1000, 0)) < 1e-6, '長軸の端から始まっていない');
  assert.ok(dist(arc[arc.length - 1], vec(-1000, 0)) < 1e-6, '長軸の反対端で終わっていない');
});

test('楕円は長半径と比のとおりの大きさになる', async () => {
  const { ellipsePoints } = await import('../src/core/geometry.ts');
  const pts = ellipsePoints(vec(500, 200), 1000, 0.4, 0);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  assert.ok(Math.abs(Math.max(...xs) - 1500) < 1, `長軸が合わない (${Math.max(...xs)})`);
  assert.ok(Math.abs(Math.max(...ys) - 600) < 1, `短軸が合わない (${Math.max(...ys)})`);

  // 90 度傾けると長短が入れ替わる
  const tilted = ellipsePoints(vec(0, 0), 1000, 0.4, Math.PI / 2);
  assert.ok(Math.abs(Math.max(...tilted.map((p) => p.y)) - 1000) < 1, '傾けた長軸が合わない');
});

test('正多角形は外接円の上に等間隔で並ぶ', async () => {
  const { regularPolygonPoints } = await import('../src/core/geometry.ts');
  const pts = regularPolygonPoints(vec(0, 0), 1000, 6, 0);
  assert.equal(pts.length, 6);
  for (const p of pts) assert.ok(Math.abs(dist(p, vec(0, 0)) - 1000) < 1e-6, '外接円の上にない');
  // 隣どうしの距離が揃う＝等間隔
  const edge = dist(pts[0], pts[1]);
  for (let i = 0; i < 6; i++) {
    assert.ok(Math.abs(dist(pts[i], pts[(i + 1) % 6]) - edge) < 1e-6, '辺の長さが揃っていない');
  }
  // 6 角形の辺は半径と同じ長さ
  assert.ok(Math.abs(edge - 1000) < 1e-6, `6 角形の辺が半径と違う (${edge})`);
});

test('辺の数は 3 未満にならない', async () => {
  const { regularPolygonPoints } = await import('../src/core/geometry.ts');
  assert.equal(regularPolygonPoints(vec(0, 0), 1000, 2, 0).length, 3);
  assert.equal(regularPolygonPoints(vec(0, 0), 1000, 0, 0).length, 3);
});

/**
 * ダブルラインは**1 つの実体として持たない。** 中心線の両側にオフセットした
 * 2 本の折れ線として置く。幅を後から変えたくなったら、そのとき種別にする。
 */
test('ダブルラインは中心線の両側に同じ距離だけ出る', async () => {
  const { offsetPolyline } = await import('../src/core/geometry.ts');
  const center = [vec(0, 0), vec(3000, 0)];
  const left = offsetPolyline(center, 100, false)!;
  const right = offsetPolyline(center, -100, false)!;

  assert.ok(left && right, 'どちらかが出ていない');
  for (let i = 0; i < center.length; i++) {
    assert.ok(Math.abs(left[i].y - 100) < 1e-6, `左が ${left[i].y}`);
    assert.ok(Math.abs(right[i].y + 100) < 1e-6, `右が ${right[i].y}`);
    // 中心線は 2 本のちょうど真ん中
    assert.ok(Math.abs((left[i].y + right[i].y) / 2 - center[i].y) < 1e-6, '真ん中からずれている');
  }
});

test('退化した中心線ではダブルラインを置かない', async () => {
  const { offsetPolyline } = await import('../src/core/geometry.ts');
  // 同じ点が続くと、オフセットは null を返して諦める
  assert.equal(offsetPolyline([vec(0, 0), vec(0, 0)], 100, false), null);
  assert.equal(offsetPolyline([vec(0, 0)], 100, false), null);
});

/**
 * 円弧の描き方は 3 通りあるが、**同じ円弧を指していれば同じものが出る**。
 * 仕様は「7 通り」と書いているが内訳が無いので、よく使う 3 通りから入れた。
 */
test('3 点を通る円の中心と半径が出る', async () => {
  const { circleThrough } = await import('../src/core/geometry.ts');
  // 原点中心・半径 1000 の円の上の 3 点
  const got = circleThrough(vec(1000, 0), vec(0, 1000), vec(-1000, 0));
  assert.ok(got, '中心が出ていない');
  assert.ok(dist(got.center, vec(0, 0)) < 1e-6, `中心が ${JSON.stringify(got.center)}`);
  assert.ok(Math.abs(got.radius - 1000) < 1e-6, `半径が ${got.radius}`);

  // 一直線に並んでいれば円にならない
  assert.equal(circleThrough(vec(0, 0), vec(1000, 0), vec(2000, 0)), null);
});

test('始点・終点・半径から中心が出て、左右で裏返る', async () => {
  const { centerFromChord } = await import('../src/core/geometry.ts');
  const a = vec(-600, 0);
  const b = vec(600, 0);
  const left = centerFromChord(a, b, 1000, true)!;
  const right = centerFromChord(a, b, 1000, false)!;

  assert.ok(left && right, '中心が出ていない');
  // どちらも両端から半径ぶん離れている
  for (const c of [left, right]) {
    assert.ok(Math.abs(dist(c, a) - 1000) < 1e-6, `始点までが ${dist(c, a)}`);
    assert.ok(Math.abs(dist(c, b) - 1000) < 1e-6, `終点までが ${dist(c, b)}`);
  }
  // 弦をはさんで反対側にある
  assert.ok(left.y * right.y < 0, '同じ側に出ている');

  // 半径が弦の半分より短ければ、円は作れない
  assert.equal(centerFromChord(a, b, 500, true), null, '届かない半径で中心が出た');
});

test('どの描き方でも、同じ 3 点からは同じ円弧が出る', async () => {
  const { circleThrough, centerFromChord } = await import('../src/core/geometry.ts');
  const { arcFromPoints } = await import('../src/core/shapes.ts');
  // 原点中心・半径 1000 の、上半分の円弧
  const from = vec(1000, 0);
  const via = vec(0, 1000);
  const to = vec(-1000, 0);

  // ①中心・始点・終点
  const byCenter = arcFromPoints(vec(0, 0), from, to);
  // ②3 点を通る
  const through = circleThrough(from, via, to)!;
  const byThree = arcFromPoints(through.center, from, to);
  // ③始点・終点・半径（左へ膨らませる）
  const chordCenter = centerFromChord(from, to, 1000, true)!;
  const byChord = arcFromPoints(chordCenter, from, to);

  for (const [name, got] of [['3 点', byThree], ['弦と半径', byChord]] as const) {
    assert.ok(dist(got.center, byCenter.center) < 1e-6, `${name}: 中心が違う`);
    assert.ok(Math.abs(got.radius - byCenter.radius) < 1e-6, `${name}: 半径が違う`);
    assert.ok(Math.abs(got.startAngle - byCenter.startAngle) < 1e-6, `${name}: 始点が違う`);
    assert.ok(Math.abs(got.endAngle - byCenter.endAngle) < 1e-6, `${name}: 終点が違う`);
  }
});

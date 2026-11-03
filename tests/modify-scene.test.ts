import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, type Scene } from '../src/core/types.ts';
import { addWall, findOrCreateNode, nodePos, openingsOnWall, wallEnds, wallLength } from '../src/core/ops.ts';
import { extendShape, extendWall, offsetShape, offsetWall, trimShape, trimWall, cutterCurves } from '../src/core/modify.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { dist, vec, type Vec } from '../src/core/geometry.ts';
import { newId } from '../src/core/id.ts';
import type { Shape } from '../src/core/shapes.ts';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const nearPt = (a: Vec, b: Vec, eps = 1e-6) => near(a.x, b.x, eps) && near(a.y, b.y, eps);

function addLine(scene: Scene, ax: number, ay: number, bx: number, by: number): string {
  const id = newId('s');
  const shape: Shape = { id, shape: 'line', layerId: LAYER_IDS.shape, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(), a: vec(ax, ay), b: vec(bx, by) };
  scene.shapes[id] = shape;
  return id;
}

const lineOf = (scene: Scene, id: string) => {
  const s = scene.shapes[id];
  assert.equal(s?.shape, 'line');
  return s as Extract<Shape, { shape: 'line' }>;
};

test('交差する2本の線をトリムできる', () => {
  const scene = emptyScene();
  const horizontal = addLine(scene, -100, 0, 100, 0);
  addLine(scene, 0, -100, 0, 100);

  assert.equal(trimShape(scene, horizontal, vec(-50, 0)), true);
  // 元が消えて、右半分だけが残る
  assert.equal(scene.shapes[horizontal], undefined);
  const lines = Object.values(scene.shapes).filter((s) => s.shape === 'line');
  assert.equal(lines.length, 2, '縦線と右半分の2本になるはず');
  const remaining = lines.find((s) => s.id !== horizontal && (s as never as { a: Vec }).a.y === 0) as never as {
    a: Vec;
    b: Vec;
  };
  assert.ok(nearPt(remaining.a, vec(0, 0)) && nearPt(remaining.b, vec(100, 0)));
});

test('交差していない線のトリムは何もしない', () => {
  const scene = emptyScene();
  const line = addLine(scene, 0, 0, 100, 0);
  addLine(scene, 0, 50, 100, 50);
  assert.equal(trimShape(scene, line, vec(50, 0)), false);
  assert.ok(scene.shapes[line], '何もしないはずが消えている');
});

test('ポリラインはトリムの対象外', () => {
  const scene = emptyScene();
  const id = newId('s');
  scene.shapes[id] = {
    id,
    shape: 'polyline',
    layerId: LAYER_IDS.shape,
    levelId: DEFAULT_LEVEL_ID,
    attrs: defaultAttrs(),
    points: [vec(0, 0), vec(100, 0), vec(100, 100)],
    closed: false,
  };
  addLine(scene, 50, -50, 50, 50);
  assert.equal(trimShape(scene, id, vec(20, 0)), false);
});

test('線を境界まで延長できる', () => {
  const scene = emptyScene();
  const line = addLine(scene, 0, 0, 100, 0);
  addLine(scene, 300, -50, 300, 50);

  assert.equal(extendShape(scene, line, vec(100, 0)), true);
  assert.ok(nearPt(lineOf(scene, line).b, vec(300, 0)), JSON.stringify(lineOf(scene, line).b));
  assert.ok(nearPt(lineOf(scene, line).a, vec(0, 0)), '反対の端が動いている');
});

test('延長したあとも id が変わらない', () => {
  const scene = emptyScene();
  const line = addLine(scene, 0, 0, 100, 0);
  addLine(scene, 300, -50, 300, 50);
  extendShape(scene, line, vec(100, 0));
  assert.ok(scene.shapes[line], '延長で id が変わってしまっている');
});

test('線をオフセットすると平行な線が増える', () => {
  const scene = emptyScene();
  const line = addLine(scene, 0, 0, 1000, 0);
  const created = offsetShape(scene, line, 200, vec(500, 300))!;
  assert.ok(created);
  const copy = lineOf(scene, created);
  assert.ok(nearPt(copy.a, vec(0, 200)), `上側に出ていない: ${JSON.stringify(copy.a)}`);
  assert.ok(scene.shapes[line], '元が消えている');

  // 反対側をクリックすれば反対側に出る
  const below = lineOf(scene, offsetShape(scene, line, 200, vec(500, -300))!);
  assert.ok(nearPt(below.a, vec(0, -200)));
});

test('円のオフセットは内外で半径が変わる', () => {
  const scene = emptyScene();
  const id = newId('s');
  scene.shapes[id] = { id, shape: 'circle', layerId: LAYER_IDS.shape, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(), center: vec(0, 0), radius: 500 };

  const outer = scene.shapes[offsetShape(scene, id, 100, vec(1000, 0))!];
  assert.equal(outer.shape === 'circle' && outer.radius, 600);
  const inner = scene.shapes[offsetShape(scene, id, 100, vec(0, 0))!];
  assert.equal(inner.shape === 'circle' && inner.radius, 400);
});

test('半径より大きく内側へオフセットはできない', () => {
  const scene = emptyScene();
  const id = newId('s');
  scene.shapes[id] = { id, shape: 'circle', layerId: LAYER_IDS.shape, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(), center: vec(0, 0), radius: 100 };
  assert.equal(offsetShape(scene, id, 200, vec(0, 0)), null);
});

test('文字と点はオフセットできない', () => {
  const scene = emptyScene();
  const id = newId('s');
  scene.shapes[id] = { id, shape: 'point', layerId: LAYER_IDS.shape, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(), at: vec(0, 0) };
  assert.equal(offsetShape(scene, id, 100, vec(100, 100)), null);
});

test('ロックされた画層の図形は相手にしない', () => {
  const scene = emptyScene();
  const line = addLine(scene, -100, 0, 100, 0);
  addLine(scene, 0, -100, 0, 100);
  assert.equal(cutterCurves(scene, { shapeId: line }).length, 1);

  scene.layers[LAYER_IDS.shape].locked = true;
  assert.equal(cutterCurves(scene, { shapeId: line }).length, 0, 'ロック中の図形を相手にしている');
});

// --- 壁 ---

test('壁を延長すると角が閉じて部屋ができる', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const c = findOrCreateNode(scene, vec(4000, 3000));
  const d = findOrCreateNode(scene, vec(0, 3000));
  addWall(scene, a, b, 100);
  addWall(scene, b, c, 100);
  addWall(scene, c, d, 100);
  // 最後の1辺を 500mm 手前で止める
  const shortWall = addWall(scene, d, findOrCreateNode(scene, vec(0, 500)), 100)!;

  assert.equal(detectRooms(scene).length, 0, '前提: まだ閉じていない');
  assert.equal(extendWall(scene, shortWall.id, vec(0, 400)), true);
  assert.equal(detectRooms(scene).length, 1, '角が閉じていない');
});

test('壁をオフセットすると厚みと画層を引き継いだ平行な壁ができる', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const wall = addWall(scene, a, b, 250, LAYER_IDS.axis)!;

  const created = offsetWall(scene, wall.id, 900, vec(2000, 500))!;
  assert.ok(created);
  const copy = scene.walls[created];
  assert.equal(copy.thickness, 250);
  assert.equal(copy.layerId, LAYER_IDS.axis);
  const [ca] = wallEnds(scene, copy);
  assert.ok(nearPt(ca, vec(0, 900)), JSON.stringify(ca));
  assert.ok(near(wallLength(scene, copy), 4000));
});

test('壁をトリムすると、クリックした側が消える', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(-2000, 0));
  const b = findOrCreateNode(scene, vec(2000, 0));
  const target = addWall(scene, a, b, 100)!;
  // 交差する壁
  addWall(scene, findOrCreateNode(scene, vec(0, -1000)), findOrCreateNode(scene, vec(0, 1000)), 100);

  assert.equal(trimWall(scene, target.id, vec(-1000, 0)), true);
  const horizontal = Object.values(scene.walls).filter((w) => {
    const [wa, wb] = wallEnds(scene, w);
    return Math.abs(wa.y) < 1 && Math.abs(wb.y) < 1;
  });
  assert.equal(horizontal.length, 1, '水平な壁が1本だけ残るはず');
  const [ha, hb] = wallEnds(scene, horizontal[0]);
  assert.ok(Math.min(ha.x, hb.x) >= -1, `左側が残っている: ${ha.x}, ${hb.x}`);
});

test('壁のトリムで、切断線をまたぐ開口部は消える', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(-2000, 0));
  const b = findOrCreateNode(scene, vec(2000, 0));
  const target = addWall(scene, a, b, 100)!;
  addWall(scene, findOrCreateNode(scene, vec(0, -1000)), findOrCreateNode(scene, vec(0, 1000)), 100);

  // 中央（切断線の上）にまたがる開口
  const openingId = newId('o');
  scene.openings[openingId] = {
    id: openingId,
    wallId: target.id,
    offset: 2000,
    width: 1600,
    kind: 'door',
    flipX: false,
    flipY: false,
    sillHeight: null,
    bay: null,
    designation: '',
    leaves: 2,
    height: null,
    layerId: LAYER_IDS.opening,
    attrs: defaultAttrs(),
  };

  trimWall(scene, target.id, vec(-1000, 0));
  assert.equal(scene.openings[openingId], undefined, '行き場のない開口が残っている');
});

test('交差相手が無い壁は延長もトリムもできない', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(1000, 0));
  const wall = addWall(scene, a, b, 100)!;
  assert.equal(extendWall(scene, wall.id, vec(1000, 0)), false);
  assert.equal(trimWall(scene, wall.id, vec(500, 0)), false);
  assert.ok(near(dist(nodePos(scene, a), nodePos(scene, b)), 1000), '何もしないはずが動いている');
  assert.equal(openingsOnWall(scene, wall.id).length, 0);
});

/**
 * 分割はトリムと**同じ道を通り、出口だけが違う**。
 * トリムは pick の入る区間を落とし、分割は全部残す。
 */
test('交差する線を分割すると 2 本になる', async () => {
  const { splitShape } = await import('../src/core/modify.ts');
  const scene = emptyScene();
  const id = addLine(scene, 0, 0, 3000, 0);
  addLine(scene, 1500, -1000, 1500, 1000);

  assert.ok(splitShape(scene, id, vec(500, 0)), '分割できない');
  const lines = Object.values(scene.shapes).filter((s) => s.shape === 'line');
  // 切った線が 2 本 + 刃の 1 本
  assert.equal(lines.length, 3, `本数が合わない (${lines.length})`);
  assert.equal(scene.shapes[id], undefined, '元の図形が残っている');

  // **どちらも消えていない。** トリムなら片方が消える
  const halves = lines.filter((s) => s.shape === 'line' && Math.abs(s.a.y) < 1e-6 && Math.abs(s.b.y) < 1e-6);
  assert.equal(halves.length, 2, '横の線が 2 本になっていない');
  const total = halves.reduce((sum, s) => sum + (s.shape === 'line' ? dist(s.a, s.b) : 0), 0);
  assert.ok(Math.abs(total - 3000) < 1e-6, `合計の長さが変わった (${total})`);
});

test('交わっていなければ分割しない', async () => {
  const { splitShape } = await import('../src/core/modify.ts');
  const scene = emptyScene();
  const id = addLine(scene, 0, 0, 3000, 0);
  addLine(scene, 5000, -1000, 5000, 1000);
  assert.equal(splitShape(scene, id, vec(500, 0)), false, '交わっていないのに分割した');
  assert.ok(scene.shapes[id], '何もしないはずが消えている');
});

test('指した範囲だけを消しゴムで抜ける（交点が無くても）', async () => {
  const { eraseShapeSpan } = await import('../src/core/modify.ts');
  const scene = emptyScene();
  // **刃になる図形を 1 つも置かない。** トリムも分割もここでは何もできない
  const id = addLine(scene, 0, 0, 3000, 0);

  assert.ok(eraseShapeSpan(scene, id, vec(1000, 0), vec(2000, 0)), '抜けない');
  const lines = Object.values(scene.shapes).filter((s) => s.shape === 'line');
  assert.equal(lines.length, 2, `2 本にならない (${lines.length})`);
  const total = lines.reduce((sum, s) => sum + (s.shape === 'line' ? dist(s.a, s.b) : 0), 0);
  assert.ok(Math.abs(total - 2000) < 1e-6, `抜いたぶんが合わない (${total})`);
});

test('端から抜くと 1 本だけ残る', async () => {
  const { eraseShapeSpan } = await import('../src/core/modify.ts');
  const scene = emptyScene();
  const id = addLine(scene, 0, 0, 3000, 0);
  assert.ok(eraseShapeSpan(scene, id, vec(-500, 0), vec(1000, 0)), '抜けない');
  const lines = Object.values(scene.shapes).filter((s) => s.shape === 'line');
  assert.equal(lines.length, 1, `1 本にならない (${lines.length})`);
  const left = lines[0];
  assert.ok(left.shape === 'line' && Math.abs(dist(left.a, left.b) - 2000) < 1e-6, '残りの長さが合わない');
});

test('壁も分割できて、開口が付いていれば引き継がれる', async () => {
  const { makeOpening } = await import('./make.ts');
  const { splitWall } = await import('../src/core/ops.ts');
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(6000, 0));
  const wall = addWall(scene, a, b, 120)!;
  const op = makeOpening(wall.id, { kind: 'door', offset: 1000, width: 800 });
  scene.openings[op.id] = op;

  const mid = splitWall(scene, wall.id, vec(3000, 0));
  assert.ok(mid, '分割できない');
  assert.equal(Object.keys(scene.walls).length, 2, '2 本にならない');
  // **開口が消えていない。** `splitWall` が引き継ぐ
  assert.equal(Object.keys(scene.openings).length, 1, '開口が消えた');
  const kept = Object.values(scene.openings)[0];
  const host = scene.walls[kept.wallId];
  assert.ok(host, '開口の乗る壁が無い');
  assert.ok(Math.abs(kept.offset - 1000) < 1e-6, `開口の位置がずれた (${kept.offset})`);
});

/**
 * 角の処理は `Curve` 層に書いてあるので、**図形にも壁にも同じものが効く**。
 * ただし壁の角の丸めだけは断る——`Wall` が直線で、円弧壁がまだ無いため。
 */
test('図形どうしを面取りすると、2 本が短くなって橋が架かる', async () => {
  const { cornerEntities } = await import('../src/core/corner.ts');
  const scene = emptyScene();
  const h = addLine(scene, -2000, 0, 0, 0);
  const v = addLine(scene, 0, 0, 0, 2000);

  assert.ok(
    cornerEntities(scene, { type: 'shape', id: h }, { type: 'shape', id: v },
      { kind: 'chamfer', distance: 500, radius: 0 }),
    '面取りできない',
  );
  // 元の 2 本は id を保ったまま短くなる
  assert.ok(Math.abs(dist(lineOf(scene, h).a, lineOf(scene, h).b) - 1500) < 1e-6, '1 本目が短くなっていない');
  assert.ok(Math.abs(dist(lineOf(scene, v).a, lineOf(scene, v).b) - 1500) < 1e-6, '2 本目が短くなっていない');
  // 橋が 1 本増えている
  assert.equal(Object.keys(scene.shapes).length, 3, '橋が架かっていない');
});

test('図形どうしを丸めると、円弧が架かる', async () => {
  const { cornerEntities } = await import('../src/core/corner.ts');
  const scene = emptyScene();
  const h = addLine(scene, -2000, 0, 0, 0);
  const v = addLine(scene, 0, 0, 0, 2000);

  assert.ok(
    cornerEntities(scene, { type: 'shape', id: h }, { type: 'shape', id: v },
      { kind: 'fillet', distance: 0, radius: 400 }),
    '丸められない',
  );
  const arcs = Object.values(scene.shapes).filter((s) => s.shape === 'arc');
  assert.equal(arcs.length, 1, '円弧が架かっていない');
  assert.ok(arcs[0].shape === 'arc' && Math.abs(arcs[0].radius - 400) < 1e-6, '半径が違う');
});

test('壁の角は落とせるが、丸められない', async () => {
  const { cornerEntities } = await import('../src/core/corner.ts');
  const scene = emptyScene();
  const corner = findOrCreateNode(scene, vec(0, 0));
  const left = findOrCreateNode(scene, vec(-3000, 0));
  const up = findOrCreateNode(scene, vec(0, 3000));
  const w1 = addWall(scene, left, corner, 120)!;
  const w2 = addWall(scene, corner, up, 120)!;

  // **丸めは断る。** 円弧の壁がまだ無いので、置く先が無い
  assert.equal(
    cornerEntities(scene, { type: 'wall', id: w1.id }, { type: 'wall', id: w2.id },
      { kind: 'fillet', distance: 0, radius: 400 }),
    false,
    '壁を丸めてしまった',
  );
  assert.equal(Object.keys(scene.walls).length, 2, '断ったのに壁が増えた');

  // 面取りは効く。新しい壁が 1 本増える
  assert.ok(
    cornerEntities(scene, { type: 'wall', id: w1.id }, { type: 'wall', id: w2.id },
      { kind: 'chamfer', distance: 500, radius: 0 }),
    '壁を面取りできない',
  );
  assert.equal(Object.keys(scene.walls).length, 3, '面取りの壁が増えていない');
  // 壁は線に差し替わらず、壁のまま
  for (const wall of Object.values(scene.walls)) {
    assert.ok(wall.thickness > 0, '厚みを失った');
  }
});

/**
 * 結合は**端点で繋ぐところまで**。閉じた図形どうしのブール演算は別物で、
 * `core/geometry.ts` に多角形の論理演算が無い（確認事項 11）。
 */
test('端点が合う 2 本の線が 1 本の折れ線になる', async () => {
  const { joinShapes } = await import('../src/core/join.ts');
  const scene = emptyScene();
  const a = addLine(scene, 0, 0, 1000, 0);
  const b = addLine(scene, 1000, 0, 1000, 800);

  assert.ok(joinShapes(scene, a, b), '繋げない');
  assert.equal(Object.keys(scene.shapes).length, 1, '1 つにまとまっていない');
  const got = scene.shapes[a];
  assert.equal(got.shape, 'polyline');
  if (got.shape !== 'polyline') return;
  assert.deepEqual(got.points.map((p) => [p.x, p.y]), [[0, 0], [1000, 0], [1000, 800]]);
  assert.equal(got.closed, false);
});

test('向きが逆でも繋がる', async () => {
  const { joinShapes } = await import('../src/core/join.ts');
  const scene = emptyScene();
  // 2 本目が終点どうしで接している
  const a = addLine(scene, 0, 0, 1000, 0);
  const b = addLine(scene, 1000, 800, 1000, 0);
  assert.ok(joinShapes(scene, a, b), '繋げない');
  const got = scene.shapes[a];
  assert.ok(got.shape === 'polyline' && got.points.length === 3, '3 点にならない');
});

test('端点が離れていれば繋がない（勝手に伸ばさない）', async () => {
  const { joinShapes } = await import('../src/core/join.ts');
  const scene = emptyScene();
  const a = addLine(scene, 0, 0, 1000, 0);
  const b = addLine(scene, 1100, 0, 1100, 800);
  // **伸ばして繋ぐことはしない。** どちらをどれだけ伸ばすかは人が決める
  assert.equal(joinShapes(scene, a, b), false, '離れているのに繋いだ');
  assert.equal(Object.keys(scene.shapes).length, 2, '図形が減っている');
});

test('一直線の壁 2 本が 1 本になり、開口の位置が保たれる', async () => {
  const { joinWalls } = await import('../src/core/join.ts');
  const { makeOpening } = await import('./make.ts');
  const { wallEnds } = await import('../src/core/ops.ts');

  for (const flip of [false, true]) {
    const scene = emptyScene();
    const left = findOrCreateNode(scene, vec(0, 0));
    const mid = findOrCreateNode(scene, vec(3000, 0));
    const right = findOrCreateNode(scene, vec(8000, 0));
    // flip のときは、残す側の壁の向きを逆にして両方の経路を通す
    const w1 = flip ? addWall(scene, mid, left, 120)! : addWall(scene, left, mid, 120)!;
    const w2 = addWall(scene, mid, right, 120)!;
    // それぞれの壁の、世界座標 x = 1000 と x = 5000 のところに建具を置く
    const o1 = makeOpening(w1.id, { kind: 'door', offset: flip ? 2000 : 1000, width: 600 });
    const o2 = makeOpening(w2.id, { kind: 'door', offset: 2000, width: 600 });
    scene.openings[o1.id] = o1;
    scene.openings[o2.id] = o2;

    assert.ok(joinWalls(scene, w1.id, w2.id), `${flip}: 繋げない`);
    assert.equal(Object.keys(scene.walls).length, 1, `${flip}: 1 本になっていない`);
    assert.equal(Object.keys(scene.openings).length, 2, `${flip}: 建具が消えた`);

    // **世界座標での位置が保たれる。** 壁の向きが変わっても動かない
    const wall = Object.values(scene.walls)[0];
    const [a, b] = wallEnds(scene, wall);
    for (const [id, worldX] of [[o1.id, 1000], [o2.id, 5000]] as const) {
      const op = scene.openings[id];
      const t = op.offset / dist(a, b);
      const x = a.x + (b.x - a.x) * t;
      assert.ok(Math.abs(x - worldX) < 1e-6, `${flip}: ${id} が ${x}（${worldX} のはず）`);
    }
  }
});

test('角になっている壁や、3 本が集まるノードでは繋がない', async () => {
  const { joinWalls } = await import('../src/core/join.ts');
  const scene = emptyScene();
  const corner = findOrCreateNode(scene, vec(0, 0));
  const left = findOrCreateNode(scene, vec(-3000, 0));
  const up = findOrCreateNode(scene, vec(0, 3000));
  const w1 = addWall(scene, left, corner, 120)!;
  const w2 = addWall(scene, corner, up, 120)!;
  // 直角なので一直線ではない
  assert.equal(joinWalls(scene, w1.id, w2.id), false, '角を繋いだ');

  // 一直線でも、3 本目が取り付いていれば繋がない
  const scene2 = emptyScene();
  const a = findOrCreateNode(scene2, vec(0, 0));
  const m = findOrCreateNode(scene2, vec(3000, 0));
  const b = findOrCreateNode(scene2, vec(6000, 0));
  const t = findOrCreateNode(scene2, vec(3000, 2000));
  const s1 = addWall(scene2, a, m, 120)!;
  const s2 = addWall(scene2, m, b, 120)!;
  addWall(scene2, m, t, 120);
  assert.equal(joinWalls(scene2, s1.id, s2.id), false, '3 本が集まるノードで繋いだ');
});

/**
 * 頂点編集。**壁の角はここに来ない**——ノードのピック・スナップ・
 * ドラッグ・統合・分割は全部あって、選択ツールで既に動く。
 */
test('頂点を動かすと図形が追従する', async () => {
  const { moveVertex } = await import('../src/core/vertexOps.ts');
  const scene = emptyScene();
  const id = addLine(scene, 0, 0, 1000, 0);
  const next = moveVertex(scene.shapes[id], 1, vec(1000, 500))!;
  assert.ok(next && next.shape === 'line', '動かせない');
  if (next.shape === 'line') {
    assert.deepEqual([next.b.x, next.b.y], [1000, 500]);
    assert.deepEqual([next.a.x, next.a.y], [0, 0], '反対の端まで動いた');
  }
  // 番号が範囲外なら何もしない
  assert.equal(moveVertex(scene.shapes[id], 5, vec(0, 0)), null);
});

test('辺の上に頂点を足すと、線は折れ線になる', async () => {
  const { insertVertex } = await import('../src/core/vertexOps.ts');
  const scene = emptyScene();
  const id = addLine(scene, 0, 0, 2000, 0);
  const next = insertVertex(scene.shapes[id], 0, vec(1000, 400))!;
  assert.ok(next && next.shape === 'polyline', '折れ線にならない');
  if (next.shape === 'polyline') {
    assert.deepEqual(next.points.map((p) => [p.x, p.y]), [[0, 0], [1000, 400], [2000, 0]]);
    assert.equal(next.id, id, 'id が変わった');
  }
});

test('2 点を割る頂点削除はしない（保存すると図形が消えるため）', async () => {
  const { removeVertex, insertVertex } = await import('../src/core/vertexOps.ts');
  const scene = emptyScene();
  const id = addLine(scene, 0, 0, 2000, 0);
  const poly = insertVertex(scene.shapes[id], 0, vec(1000, 400))!;

  const after = removeVertex(poly, 1)!;
  assert.ok(after && after.shape === 'polyline' && after.points.length === 2, '落とせない');
  // ここからもう 1 つ落とすと 1 点になる。`shapeRead` が 2 点以上を要求している
  assert.equal(removeVertex(after, 0), null, '2 点を割って落とした');
});

test('頂点とその辺を、カーソルの近さで拾える', async () => {
  const { pickVertex, pickEdge } = await import('../src/core/vertexOps.ts');
  const scene = emptyScene();
  const id = addLine(scene, 0, 0, 2000, 0);

  const v = pickVertex(scene, vec(1990, 10), 60)!;
  assert.ok(v, '頂点を拾えない');
  assert.equal(v.index, 1, '近いほうの頂点でない');
  assert.equal(pickVertex(scene, vec(1000, 0), 60), null, '辺のまんなかで頂点を拾った');

  const e = pickEdge(scene, vec(1000, 20), 60)!;
  assert.ok(e, '辺を拾えない');
  assert.equal(e.shapeId, id);
  assert.ok(Math.abs(e.at.x - 1000) < 1e-6 && Math.abs(e.at.y) < 1e-6, '辺の上の点が違う');
});

test('閉じた折れ線では、最後の辺も拾える', async () => {
  const { pickEdge } = await import('../src/core/vertexOps.ts');
  const scene = emptyScene();
  const id = newId('s');
  scene.shapes[id] = {
    id, shape: 'polyline', layerId: LAYER_IDS.shape, levelId: DEFAULT_LEVEL_ID,
    attrs: defaultAttrs(),
    points: [vec(0, 0), vec(2000, 0), vec(2000, 2000)],
    closed: true,
  };
  // 閉じ辺（最後の点 → 最初の点）の途中
  const e = pickEdge(scene, vec(1000, 1000), 80);
  assert.ok(e, '閉じ辺を拾えない');
  assert.equal(e?.edgeIndex, 2, '閉じ辺の番号が違う');
});

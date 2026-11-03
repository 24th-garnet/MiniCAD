import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closedPolygonOf, extrudeShapes, selfIntersects } from '../src/core/extrude.ts';
import { SHAPE_KINDS, type Shape, type ShapeKind } from '../src/core/shapes.ts';
import { transformEntities } from '../src/core/transformOps.ts';
import { mirror, translation } from '../src/core/transform.ts';
import { buildFixtureFaces, fixtureFingerprint } from '../src/render3d/fixture3d.ts';
import { outline } from '../src/core/fixture.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { dist, signedArea, vec, type Vec } from '../src/core/geometry.ts';
import { emptyScene, type Scene } from '../src/core/types.ts';
import type { Face3 } from '../src/render3d/mesh.ts';

/**
 * 押し出し（20 段）。閉じた図形を立体にする。
 *
 * **`extrudePrism` は凹多角形でも正しい**ので、三角形分割は持ち込まない。
 * 弾くのは自己交差だけ——塗りは nonzero、拾いは偶奇なので、8 の字では
 * 重なった部分の答えが食い違う。
 */

function put(scene: Scene, shape: Omit<Shape, 'id' | 'layerId' | 'attrs'> & { id: string }): string {
  scene.shapes[shape.id] = {
    ...shape, layerId: LAYER_IDS.shape, attrs: defaultAttrs(),
  } as Shape;
  return shape.id;
}

const polyline = (scene: Scene, id: string, points: Vec[], closed = true): string =>
  put(scene, { id, shape: 'polyline', points, closed } as never);

/** L 字（凹多角形）。反時計回り */
const L_SHAPE: Vec[] = [
  vec(0, 0), vec(3000, 0), vec(3000, 1000), vec(1000, 1000), vec(1000, 3000), vec(0, 3000),
];

test('閉じた折れ線は押し出せる。開いた折れ線は押し出せない', () => {
  const scene = emptyScene();
  const open = polyline(scene, 'a', [vec(0, 0), vec(1000, 0), vec(1000, 1000)], false);
  const closed = polyline(scene, 'b', [vec(0, 0), vec(1000, 0), vec(1000, 1000)], true);
  assert.equal(closedPolygonOf(scene, open), null, '開いた折れ線が閉じていると判定された');
  assert.ok(closedPolygonOf(scene, closed), '閉じた折れ線が押し出せない');
});

test('円は閉じたものとして扱う（一周して戻るから）', () => {
  // **種別で判断していない。** `shapeOutline` が一周するかを見ているので、
  // `closed: false` で作られている円も見た目どおり閉じて見える
  const scene = emptyScene();
  const id = put(scene, { id: 'c', shape: 'circle', center: vec(0, 0), radius: 500 } as never);
  const poly = closedPolygonOf(scene, id);
  assert.ok(poly, '円が閉じていない扱いになっている');
  assert.ok(poly.length > 8, `円が ${poly.length} 点にしかならない`);
});

test('文字・点・引出線は押し出せない', () => {
  const scene = emptyScene();
  const text = put(scene, { id: 't', shape: 'text', at: vec(0, 0), text: 'あ', height: 3, angle: 0 } as never);
  const point = put(scene, { id: 'p', shape: 'point', at: vec(0, 0) } as never);
  const leader = put(scene, {
    id: 'l', shape: 'leader', at: vec(0, 0), elbow: vec(500, 500), text: 'note', height: 3,
  } as never);
  for (const id of [text, point, leader]) {
    assert.equal(closedPolygonOf(scene, id), null, `${id} が押し出せてしまう`);
  }
});

test('閉じた図形はどれも押し出せる（種別を足しても自動で効く）', () => {
  // ここが落ちたら、図形の種別を足して `shapeOutline` が一周しなくなったということ
  const closedKinds: ShapeKind[] = ['polyline', 'circle', 'regularPolygon', 'roundRect', 'ellipse'];
  for (const k of closedKinds) assert.ok(SHAPE_KINDS.includes(k), `${k} が消えている`);
});

test('8 の字は押し出せない', () => {
  // **`extrudePrism` は弾かない。** 渡すと塗り（nonzero）と当たり判定（偶奇）が
  // 重なった部分で食い違う
  const bowtie = [vec(0, 0), vec(1000, 1000), vec(1000, 0), vec(0, 1000)];
  assert.ok(selfIntersects(bowtie), '8 の字が自己交差と見なされない');
  assert.ok(!selfIntersects(L_SHAPE), '凹多角形が自己交差と見なされた');
  const scene = emptyScene();
  assert.equal(closedPolygonOf(scene, polyline(scene, 'x', bowtie)), null, '8 の字が押し出せてしまう');
});

test('押し出すと図形が消えて立体が立ち、形がそのまま残る', () => {
  const scene = emptyScene();
  const id = polyline(scene, 'L', L_SHAPE);
  const { created, rejected } = extrudeShapes(scene, [{ type: 'shape', id }], 2500);
  assert.equal(rejected, 0);
  assert.equal(created.length, 1);
  assert.equal(scene.shapes[id], undefined, '元の図形が残っている');

  const f = scene.fixtures[created[0].id];
  assert.equal(f.kind, 'extrusion');
  assert.equal(f.height, 2500);
  assert.equal(f.angle, 0, '向きを持たせると輪郭と二重に回る');
  // ワールドの輪郭が元の形と一致する（並びはどこから始まってもよい）
  const got = outline(f);
  assert.equal(got.length, L_SHAPE.length);
  for (const p of L_SHAPE) {
    assert.ok(got.some((q) => dist(p, q) < 1e-6), `(${p.x}, ${p.y}) が輪郭から消えた`);
  }
  assert.ok(signedArea(got) > 0, '輪郭が時計回りになっている（押し出しの法線が内を向く）');
});

const facesOf = (scene: Scene, id: string): Face3[] => {
  const out: Face3[] = [];
  buildFixtureFaces(scene, id, out);
  return out;
};

test('凹多角形の押し出しは、底面の形がそのまま立つ', () => {
  const scene = emptyScene();
  const id = polyline(scene, 'L', L_SHAPE);
  const fid = extrudeShapes(scene, [{ type: 'shape', id }], 2000).created[0].id;
  // 側面 6 枚 + 上下 2 枚。**三角形分割していない**
  assert.equal(facesOf(scene, fid).length, L_SHAPE.length + 2);
  const zs = facesOf(scene, fid).flatMap((f) => f.points.map((p) => p.z));
  assert.equal(Math.min(...zs), 0);
  assert.equal(Math.max(...zs), 2000);
});

test('輪郭を変えると指紋が変わる（変えないと 3D が作り直されない）', () => {
  // **ここを忘れるのがいちばん怖い。** 指紋が同じだとメッシュのキャッシュが
  // 効き続けて、輪郭を直しても 3D は古いままになる
  const scene = emptyScene();
  const id = polyline(scene, 'L', L_SHAPE);
  const fid = extrudeShapes(scene, [{ type: 'shape', id }], 2000).created[0].id;
  const before = fixtureFingerprint(scene, fid);
  scene.fixtures[fid].outline![0] = vec(-500, -500);
  assert.notEqual(fixtureFingerprint(scene, fid), before, '輪郭を変えても指紋が同じ');
});

test('複写しても輪郭を元と共有しない', () => {
  const scene = emptyScene();
  const id = polyline(scene, 'L', L_SHAPE);
  const fid = extrudeShapes(scene, [{ type: 'shape', id }], 2000).created[0].id;
  const copy = transformEntities(
    scene, [{ type: 'fixture', id: fid }],
    translation(vec(10000, 0)), { copy: true },
  );
  const copyId = copy.refs[0].id;
  scene.fixtures[copyId].outline![0] = vec(-9999, -9999);
  assert.notDeepEqual(scene.fixtures[fid].outline![0], vec(-9999, -9999), '輪郭が元と共有されている');
});

test('鏡像にすると形も裏返る（軸の向きに依らず）', () => {
  // ローカルの輪郭を裏返さないと、角度だけ鏡像になって**形は元のまま**になる。
  // **折り返す軸を斜めにしても同じ**でなければならない——`directionAngleAfter` の
  // 取り方から、ローカルの反転は常に上下（`diag(1, -1)`）になるため
  const axes: [Vec, Vec, (p: Vec) => Vec][] = [
    [vec(0, 0), vec(0, 1000), (p) => vec(-p.x, p.y)],      // x = 0
    [vec(0, 0), vec(1000, 0), (p) => vec(p.x, -p.y)],      // y = 0
    [vec(0, 0), vec(1000, 1000), (p) => vec(p.y, p.x)],    // y = x
    [vec(500, 0), vec(500, 1000), (p) => vec(1000 - p.x, p.y)],
  ];
  for (const [a, b, reflect] of axes) {
    const scene = emptyScene();
    const id = polyline(scene, 'L', L_SHAPE);
    const fid = extrudeShapes(scene, [{ type: 'shape', id }], 2000).created[0].id;
    const before = outline(scene.fixtures[fid]);
    transformEntities(scene, [{ type: 'fixture', id: fid }], mirror(a, b), { copy: false });
    const after = outline(scene.fixtures[fid]);
    assert.equal(after.length, before.length);
    for (const p of before) {
      assert.ok(after.some((q) => dist(reflect(p), q) < 1e-6),
        `(${p.x}, ${p.y}) の鏡像が輪郭に無い（軸 ${a.x},${a.y}→${b.x},${b.y}）`);
    }
    assert.ok(signedArea(after) > 0, '裏返したあと時計回りになっている');
  }
});

test('押し出しが JSON の往復を生き延びる', () => {
  const scene = emptyScene();
  const id = polyline(scene, 'L', L_SHAPE);
  const fid = extrudeShapes(scene, [{ type: 'shape', id }], 2345).created[0].id;
  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.deepEqual(back.fixtures[fid], scene.fixtures[fid], '押し出しが往復で変わった');
});

test('輪郭が 3 点に満たないファイルは種別の既定に戻る', () => {
  const scene = emptyScene();
  scene.fixtures.f = {
    id: 'f', kind: 'extrusion', x: 0, y: 0, angle: 0,
    size: { w: 1000, h: 1000 }, outline: null, combine: null, base: 0, height: 1000, label: '',
    layerId: LAYER_IDS.shape, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(),
  };
  const raw = JSON.parse(JSON.stringify(serialize(scene)));
  raw.scene.fixtures.f.outline = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  const back = deserialize(raw);
  assert.equal(back.fixtures.f.outline, null, '壊れた輪郭が残っている');
  assert.equal(outline(back.fixtures.f).length, 4, '既定の矩形に戻っていない');
});

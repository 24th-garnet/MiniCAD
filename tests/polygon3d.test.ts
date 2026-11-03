import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polygonFace } from '../src/render3d/mesh.ts';
import { rayFace } from '../src/render3d/ray.ts';
import { vec3, type Vec3 } from '../src/render3d/mat4.ts';
import { EDGE_INVISIBLE } from '../src/io/dxfPrimitive.ts';
import { sceneToDxf3d } from '../src/io/dxf3d.ts';
import { extrudeShapes } from '../src/core/extrude.ts';
import { buildFixtureFaces } from '../src/render3d/fixture3d.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { vec } from '../src/core/geometry.ts';
import { emptyScene, type Scene } from '../src/core/types.ts';
import type { Face3, FaceSource } from '../src/render3d/mesh.ts';

/**
 * 3D 多角形（21 段）。**任意の平らな多角形を 1 枚の面として扱えること。**
 *
 * `polygonFace` は前からあったが、法線を**最初の 3 点の外積**で出していたので、
 * 凹多角形の反射頂点が `points[1]` に来ると裏返った。裏返ると `rayFace` が
 * 背面として弾き、**見えているのにクリックが素通りする**。
 */

const SRC: FaceSource = { ref: null, levelId: 'L1' };

/** L 字（凹）。z = 0 の平面に置く。上から見て反時計回り */
const L: Vec3[] = [
  vec3(0, 0, 0), vec3(3000, 0, 0), vec3(3000, 1000, 0),
  vec3(1000, 1000, 0), vec3(1000, 3000, 0), vec3(0, 3000, 0),
];

/** 並びを `k` だけずらす。形は同じで、始点だけが変わる */
const rotateStart = (points: Vec3[], k: number): Vec3[] =>
  points.map((_, i) => points[(i + k) % points.length]);

test('凹多角形の法線は、並びの始点に依らない', () => {
  // **ここが落とし穴だった。** `points[1]` が反射頂点（L 字のへこんだ角）に
  // 来る並びがあり、そのときだけ法線が裏返っていた
  const base = polygonFace(L, '#000', 'wall', SRC).normal;
  assert.ok(base.z > 0.99, `反時計回りなのに上を向いていない (${JSON.stringify(base)})`);
  for (let k = 1; k < L.length; k++) {
    const n = polygonFace(rotateStart(L, k), '#000', 'wall', SRC).normal;
    assert.ok(Math.hypot(n.x - base.x, n.y - base.y, n.z - base.z) < 1e-9,
      `${k} 個ずらすと法線が ${JSON.stringify(n)} になる`);
  }
});

test('巻きを逆にすると法線も逆になる', () => {
  const n = polygonFace([...L].reverse(), '#000', 'wall', SRC).normal;
  assert.ok(n.z < -0.99, `時計回りなのに下を向いていない (${JSON.stringify(n)})`);
});

test('最初の 3 点が一直線でも法線が出る', () => {
  // 外積だと最初の組が 0 ベクトルになる。ニューウェル法は全部の辺を使うので落ちない
  const strip = [vec3(0, 0, 0), vec3(1000, 0, 0), vec3(2000, 0, 0), vec3(2000, 500, 0), vec3(0, 500, 0)];
  const n = polygonFace(strip, '#000', 'wall', SRC).normal;
  assert.ok(n.z > 0.99, `法線が ${JSON.stringify(n)}`);
});

test('凹多角形は、並びの始点がどこでも真上から拾える', () => {
  // **裏返ると `rayFace` が背面として弾く。** 見えているのに素通りする状態になる
  const inside = vec3(500, 500, 0); // L 字の脚の上（へこんだ側ではない）
  for (let k = 0; k < L.length; k++) {
    const face = polygonFace(rotateStart(L, k), '#000', 'wall', SRC);
    const ray = { origin: vec3(inside.x, inside.y, 5000), direction: vec3(0, 0, -1) };
    assert.ok(rayFace(ray, face, 1) !== null, `${k} 個ずらすと拾えない`);
  }
});

test('凹の押し出しは、輪郭の始点をずらしても上面が外を向く', () => {
  // 実際に通る道でも確かめる。押し出しの上下は `extrudePrism` が作る
  for (let k = 0; k < 6; k++) {
    const scene = emptyScene();
    const points = [vec(0, 0), vec(3000, 0), vec(3000, 1000), vec(1000, 1000), vec(1000, 3000), vec(0, 3000)];
    scene.shapes.s = {
      id: 's', shape: 'polyline', closed: true, layerId: LAYER_IDS.shape, attrs: defaultAttrs(),
      points: points.map((_, i) => points[(i + k) % points.length]),
    } as never;
    const id = extrudeShapes(scene, [{ type: 'shape', id: 's' }], 1000).created[0].id;
    const faces: Face3[] = [];
    buildFixtureFaces(scene, id, faces);
    const top = faces.find((f) => f.normal.z > 0.5);
    const bottom = faces.find((f) => f.normal.z < -0.5);
    assert.ok(top && bottom, `${k} 個ずらすと上面か下面が消える`);
    assert.ok(top.points.length === 6 && bottom.points.length === 6, '上下が 6 角形でない');
  }
});

/** 書いた DXF を、タグの組で読み直す。オラクルは 70 を 3DFACE 用に読めない */
function facesWithFlags(text: string): { flag: number; points: number }[] {
  const lines = text.split('\n').map((l) => l.trim());
  const out: { flag: number; points: number }[] = [];
  let current: { flag: number; points: number } | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i];
    const value = lines[i + 1];
    if (code === '0') {
      if (current) out.push(current);
      current = value === '3DFACE' ? { flag: 0, points: 0 } : null;
      continue;
    }
    if (!current) continue;
    if (code === '70') current.flag = Number(value);
    if (code === '10' || code === '11' || code === '12' || code === '13') current.points += 1;
  }
  if (current) out.push(current);
  return out;
}

/** L 字の床を持つシーン。5 点以上の面が出るので扇状に割られる */
function concaveFloor(): Scene {
  const scene = emptyScene();
  scene.shapes.s = {
    id: 's', shape: 'polyline', closed: true, layerId: LAYER_IDS.shape, attrs: defaultAttrs(),
    points: [vec(0, 0), vec(3000, 0), vec(3000, 1000), vec(1000, 1000), vec(1000, 3000), vec(0, 3000)],
  } as never;
  extrudeShapes(scene, [{ type: 'shape', id: 's' }], 1000);
  return scene;
}

test('扇状に割った面は、内部の辺を隠す札を持つ', () => {
  // 書かないと、L 字の床を AutoCAD で開いたときに扇の骨が線として見える
  const { text } = sceneToDxf3d(concaveFloor(), []);
  const faces = facesWithFlags(text);
  assert.ok(faces.length > 0, '面が出ていない');
  for (const f of faces) assert.equal(f.points, 4, `3DFACE が ${f.points} 点`);

  // 6 角形 1 枚は 4 枚の三角形に割れる。上面と下面で 2 枚あるので 8 枚
  const flagged = faces.filter((f) => f.flag !== 0);
  assert.equal(flagged.length, 8, `札の付いた面が ${flagged.length} 枚`);
  // 退化した 4 番目の点どうしの辺は、どの三角形でも隠す
  for (const f of flagged) {
    assert.ok((f.flag & EDGE_INVISIBLE[2]) !== 0, '退化した辺が隠されていない');
  }
  // 扇 1 枚ぶんずつ見る。1 枚目は 1 本目の辺が外周（p0→p1）、
  // 最後の 1 枚は 4 本目が外周（pn-1→p0）。間の 2 枚はどちらも内部
  for (const start of [0, 4]) {
    const fan = flagged.slice(start, start + 4);
    assert.equal(fan[0].flag & EDGE_INVISIBLE[0], 0, '外周の辺まで隠している（扇の最初）');
    assert.notEqual(fan[0].flag & EDGE_INVISIBLE[3], 0, '内部の辺が見えたまま（扇の最初）');
    assert.notEqual(fan[3].flag & EDGE_INVISIBLE[0], 0, '内部の辺が見えたまま（扇の最後）');
    assert.equal(fan[3].flag & EDGE_INVISIBLE[3], 0, '外周の辺まで隠している（扇の最後）');
    for (const mid of fan.slice(1, 3)) {
      assert.notEqual(mid.flag & EDGE_INVISIBLE[0], 0, '内部の辺が見えたまま（扇の途中）');
      assert.notEqual(mid.flag & EDGE_INVISIBLE[3], 0, '内部の辺が見えたまま（扇の途中）');
    }
  }
});

test('4 点までの面には札を付けない', () => {
  // 既定が 0 なので、要らない行を全部の面に足さない
  const { text } = sceneToDxf3d(concaveFloor(), []);
  const faces = facesWithFlags(text);
  // 側面は 4 点ちょうど。札は付かない
  assert.ok(faces.some((f) => f.flag === 0), '札の無い面が 1 枚も無い');
});

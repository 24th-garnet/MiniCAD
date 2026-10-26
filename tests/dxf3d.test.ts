import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYER_3D, sceneToDxf3d } from '../src/io/dxf3d.ts';
import { entitiesOf, faceVertices, type DxfEnt } from './dxf-oracle.ts';
import { sampleScene } from '../src/io/sample.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { buildMesh } from '../src/render3d/mesh.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { emptyScene } from '../src/core/types.ts';

const exported = (scene = sampleScene()) => sceneToDxf3d(scene, detectRooms(scene));

test('外部パーサが 3DFACE として読み戻せる', () => {
  // **自前の思い込みで通らない。** DXF の検証はこの作法に合わせる
  const got = exported();
  const ents = entitiesOf(got.text);
  assert.ok(ents.length > 0, '何も読めなかった');
  assert.ok(ents.every((e) => e.type === '3DFACE'), '3DFACE 以外が混ざっている');
  assert.equal(ents.length, got.faces, '数えた面と書いた面が違う');
});

test('どの面も 4 点を持ち、三角形は 4 点目を繰り返す', () => {
  // 点を 3 つだけ書くと、読む側が 4 点目を原点と解釈して床まで伸びた面になる
  const ents = entitiesOf(exported().text);
  for (const e of ents as DxfEnt[]) {
    const v = faceVertices(e);
    assert.equal(v.length, 4, `頂点が ${v.length} 個`);
    for (const p of v) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), '非有限の点');
    }
  }
});

test('面の出どころが画層に出る', () => {
  const ents = entitiesOf(exported().text) as DxfEnt[];
  const used = new Set(ents.map((e) => e.layer));
  assert.ok(used.has(LAYER_3D.wall), '壁の画層が無い');
  assert.ok(used.has(LAYER_3D.floor), '床の画層が無い');
  // 平面の画層とは別の名前にして、読み込んだ側で切り分けられるようにしている
  for (const name of used) assert.match(String(name), /-3D$/);
});

test('高さを持っている（平面図ではない）', () => {
  const ents = entitiesOf(exported().text) as DxfEnt[];
  const zs = ents.flatMap((e) => faceVertices(e).map((p) => p.z));
  assert.ok(Math.max(...zs) > 2000, `いちばん高い点が ${Math.max(...zs)}`);
  assert.ok(Math.min(...zs) === 0, '床が 0 ではない');
});

test('隠した画層の面は出さない', () => {
  const scene = sampleScene();
  const before = exported(scene).faces;
  scene.layers[LAYER_IDS.furniture].visible = false;
  const after = exported(scene).faces;
  assert.ok(after < before, `家具を隠しても面が減らない (${before} → ${after})`);
});

test('メッシュの面がすべて出る（扇状分割のぶんを除いて）', () => {
  const scene = sampleScene();
  const rooms = detectRooms(scene);
  const mesh = buildMesh(scene, rooms).filter((f) => {
    const ref = f.ref;
    if (!ref) return true;
    const layerId =
      ref.type === 'wall' ? scene.walls[ref.id]?.layerId
      : ref.type === 'opening' ? scene.openings[ref.id]?.layerId
      : ref.type === 'blockInstance' ? scene.instances[ref.id]?.layerId
      : ref.type === 'fixture' ? scene.fixtures[ref.id]?.layerId
      : undefined;
    const layer = scene.layers[layerId ?? ''] ?? scene.layers[LAYER_IDS.wall];
    return layer.visible && layer.printable;
  });
  const simple = mesh.filter((f) => f.points.length >= 3 && f.points.length <= 4).length;
  const got = sceneToDxf3d(scene, rooms);
  assert.ok(got.faces >= simple, `面が足りない (${got.faces} < ${simple})`);
});

test('近似したことも落としたことも報告に出る', () => {
  // **持っていないものは、持っていないと書く**
  const got = exported();
  assert.ok(got.notes.length > 0);
  assert.ok(got.notes.some((n) => n.includes('素材も色も出していません')), '色の話が無い');
});

test('何も無いシーンでは面が 0', () => {
  const scene = emptyScene();
  const got = sceneToDxf3d(scene, detectRooms(scene));
  assert.equal(got.faces, 0);
  // それでも読める DXF であること
  assert.deepEqual(entitiesOf(got.text), []);
});

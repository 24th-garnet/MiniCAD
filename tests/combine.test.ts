import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineFixtures, explodeFixture, combineFingerprint } from '../src/core/combine.ts';
import { FIXTURE_SPECS, type Fixture, type FixtureKind } from '../src/core/fixture.ts';
import { buildFixtureFaces, fixtureFingerprint } from '../src/render3d/fixture3d.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { emptyScene, type Scene } from '../src/core/types.ts';
import type { Face3 } from '../src/render3d/mesh.ts';
import type { Vec3 } from '../src/render3d/mat4.ts';

/**
 * ブーリアンの持ち方（23 段）。**結果の形ではなく作り方を持つ。**
 *
 * 相手は母体の中にしまい込まれ、`scene.fixtures` からは消える。
 * こうすると平面にも積算にも二重に出ず、あとから「分解」で戻せる。
 */

function put(scene: Scene, id: string, kind: FixtureKind, over: Partial<Fixture> = {}): string {
  const spec = FIXTURE_SPECS[kind];
  scene.fixtures[id] = {
    id, kind, x: 0, y: 0, angle: 0,
    size: { ...spec.defaultSize }, tilt: null, outline: null, combine: null, edge: null,
    base: 0, height: 1000, label: spec.defaultLabel,
    layerId: spec.defaultLayer, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(),
    ...over,
  };
  return id;
}

const facesOf = (scene: Scene, id: string): Face3[] => {
  const out: Face3[] = [];
  buildFixtureFaces(scene, id, out);
  return out;
};

function volume(faces: readonly Face3[]): number {
  let v = 0;
  for (const f of faces) {
    const p = f.points;
    for (let i = 1; i + 1 < p.length; i++) v += det(p[0], p[i], p[i + 1]) / 6;
  }
  return v;
}
const det = (a: Vec3, b: Vec3, c: Vec3): number =>
  a.x * (b.y * c.z - b.z * c.y) - a.y * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.y - b.y * c.x);

/** 1000 立方の箱 2 つ。半分だけ重ねる */
function twoBoxes(): Scene {
  const scene = emptyScene();
  put(scene, 'a', 'box', { size: { w: 1000, h: 1000 }, height: 1000 });
  put(scene, 'b', 'box', { x: 500, size: { w: 1000, h: 1000 }, height: 1000 });
  return scene;
}

test('掛け合わせた相手は図面から消え、母体の中に入る', () => {
  const scene = twoBoxes();
  const host = combineFixtures(scene, ['a', 'b'], 'subtract')!;
  assert.equal(host, 'a');
  assert.equal(scene.fixtures.b, undefined, '相手が図面に残っている');
  assert.equal(scene.fixtures.a.combine?.op, 'subtract');
  assert.equal(scene.fixtures.a.combine?.parts.length, 1);
});

test('切り欠いた立体は、引いたぶんだけ体積が減る', () => {
  const scene = twoBoxes();
  const before = volume(facesOf(scene, 'a'));
  assert.ok(Math.abs(before - 1e9) < 1, `元の体積 ${before}`);
  combineFixtures(scene, ['a', 'b'], 'subtract');
  const after = volume(facesOf(scene, 'a'));
  assert.ok(Math.abs(after - 0.5e9) < 1, `切り欠いた体積 ${after}`);
});

test('合成した立体は、重なりを 2 度数えない', () => {
  const scene = twoBoxes();
  combineFixtures(scene, ['a', 'b'], 'unite');
  const v = volume(facesOf(scene, 'a'));
  assert.ok(Math.abs(v - 1.5e9) < 1, `合成した体積 ${v}`);
});

test('切り欠いた面も母体を指す（クリックしたら母体が選ばれる）', () => {
  const scene = twoBoxes();
  combineFixtures(scene, ['a', 'b'], 'subtract');
  for (const f of facesOf(scene, 'a')) {
    assert.equal(f.ref?.type, 'fixture');
    assert.equal(f.ref?.id, 'a', '切り欠いた面が別のものを指している');
  }
});

test('分解すると相手が図面へ戻る', () => {
  const scene = twoBoxes();
  combineFixtures(scene, ['a', 'b'], 'subtract');
  assert.equal(explodeFixture(scene, 'a'), 1);
  assert.ok(scene.fixtures.b, '相手が戻っていない');
  assert.equal(scene.fixtures.a.combine, null);
  // 形も元どおり
  assert.ok(Math.abs(volume(facesOf(scene, 'a')) - 1e9) < 1, '分解しても切り欠かれたまま');
});

test('相手を直すと指紋が変わる（変えないと 3D が古いまま）', () => {
  const scene = twoBoxes();
  combineFixtures(scene, ['a', 'b'], 'subtract');
  const before = fixtureFingerprint(scene, 'a');
  scene.fixtures.a.combine!.parts[0].x = 700;
  assert.notEqual(fixtureFingerprint(scene, 'a'), before, '相手を直しても指紋が同じ');
  assert.notEqual(combineFingerprint(scene.fixtures.a), '-');
});

test('しまい込んだ立体は床を食わない（図面に居ないので）', async () => {
  const scene = twoBoxes();
  put(scene, 'v', 'void', { x: 3000, size: { w: 1000, h: 1000 } });
  const before = Object.keys(scene.fixtures).length;
  combineFixtures(scene, ['a', 'b'], 'subtract');
  assert.equal(Object.keys(scene.fixtures).length, before - 1);
  // 部屋の検出が、しまい込んだものを見にいって落ちたりしない
  assert.doesNotThrow(() => detectRooms(scene));
});

test('ブーリアンが JSON の往復を生き延びる', () => {
  const scene = twoBoxes();
  combineFixtures(scene, ['a', 'b'], 'intersect');
  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.deepEqual(back.fixtures.a, scene.fixtures.a, '往復で変わった');
  assert.equal(back.fixtures.b, undefined, 'しまい込んだ相手が図面に出てきた');
});

test('重ねて掛けられる', () => {
  const scene = twoBoxes();
  put(scene, 'c', 'box', { y: 500, size: { w: 1000, h: 1000 }, height: 1000 });
  combineFixtures(scene, ['a', 'b'], 'subtract');
  combineFixtures(scene, ['a', 'c'], 'subtract');
  assert.equal(scene.fixtures.a.combine?.parts.length, 2);
  // x と y の両方から削られる
  const v = volume(facesOf(scene, 'a'));
  assert.ok(v < 0.5e9 && v > 0, `重ねて削った体積 ${v}`);
});

test('1 つだけでは掛けられない', () => {
  const scene = twoBoxes();
  assert.equal(combineFixtures(scene, ['a'], 'unite'), null);
  assert.equal(combineFixtures(scene, [], 'unite'), null);
  assert.equal(explodeFixture(scene, 'a'), 0, '作り方が無いのに分解できた');
});

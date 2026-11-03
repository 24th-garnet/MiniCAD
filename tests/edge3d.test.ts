import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeRings, insetOutline, maxInsetOf, EDGE_KINDS, type EdgeKind } from '../src/core/edge3d.ts';
import { FIXTURE_SPECS, type Fixture, type FixtureKind } from '../src/core/fixture.ts';
import { buildFixtureFaces, fixtureFingerprint } from '../src/render3d/fixture3d.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { signedArea, vec } from '../src/core/geometry.ts';
import { emptyScene, type Scene } from '../src/core/types.ts';
import type { Face3 } from '../src/render3d/mesh.ts';
import type { Vec3 } from '../src/render3d/mat4.ts';

/**
 * 上下の稜線の仕上げ（24 段）。テーパ・面取り・丸め。
 *
 * **稜線ではなく「高さ方向の輪郭」で表している。** 本来の 3D 面取りは
 * どの稜線を落とすかを選ぶもので、面の隣り合わせを知る構造（B-rep）が要る。
 * ここで見るのは、段を積んだ結果が**閉じていて、体積が素のものより小さい**こと。
 */

function put(scene: Scene, kind: FixtureKind, over: Partial<Fixture> = {}): Fixture {
  const spec = FIXTURE_SPECS[kind];
  const f: Fixture = {
    id: 'f', kind, x: 0, y: 0, angle: 0,
    size: { ...spec.defaultSize }, outline: null, combine: null, edge: null,
    base: 0, height: 1000, label: spec.defaultLabel,
    layerId: spec.defaultLayer, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(),
    ...over,
  };
  scene.fixtures.f = f;
  return f;
}

const facesOf = (scene: Scene): Face3[] => {
  const out: Face3[] = [];
  buildFixtureFaces(scene, 'f', out);
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

/** 面積ベクトルの総和。閉じていれば 0 */
function closureResidual(faces: readonly Face3[]): number {
  let x = 0;
  let y = 0;
  let z = 0;
  let total = 0;
  for (const f of faces) {
    const p = f.points;
    let ax = 0;
    let ay = 0;
    let az = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      ax += a.y * b.z - a.z * b.y;
      ay += a.z * b.x - a.x * b.z;
      az += a.x * b.y - a.y * b.x;
    }
    x += ax; y += ay; z += az;
    total += Math.hypot(ax, ay, az);
  }
  return total === 0 ? 0 : Math.hypot(x, y, z) / total;
}

const BOX = { size: { w: 1000, h: 1000 }, height: 1000 } as const;

test('段は下から上へ、高さが単調に増える', () => {
  for (const kind of EDGE_KINDS) {
    const rings = edgeRings({ kind, size: 100 }, 1000, 400);
    assert.ok(rings.length >= 2, `${kind}: 段が ${rings.length} 個`);
    assert.equal(rings[0].dz, 0, `${kind}: 下端から始まっていない`);
    assert.ok(Math.abs(rings[rings.length - 1].dz - 1000) < 1e-9, `${kind}: 上端で終わっていない`);
    for (let i = 1; i < rings.length; i++) {
      assert.ok(rings[i].dz >= rings[i - 1].dz - 1e-9, `${kind}: 高さが戻っている`);
      assert.ok(rings[i].inset >= -1e-9, `${kind}: 外へ膨らんでいる`);
    }
  }
});

test('大きさは高さと輪郭に収まるよう抑える', () => {
  // 抑えないと上下が交差して、体積が負の立体になる
  const huge = edgeRings({ kind: 'chamfer', size: 99999 }, 1000, 400);
  for (const r of huge) assert.ok(r.inset <= 400 + 1e-9, `縮めすぎ ${r.inset}`);
  assert.ok(huge.every((r) => r.dz >= 0 && r.dz <= 1000));
  // 0 以下なら素のまま（2 段）
  assert.deepEqual(edgeRings({ kind: 'fillet', size: 0 }, 1000, 400),
    [{ dz: 0, inset: 0 }, { dz: 1000, inset: 0 }]);
});

test('縮めすぎた輪郭は null になる', () => {
  const square = [vec(-500, -500), vec(500, -500), vec(500, 500), vec(-500, 500)];
  assert.ok(insetOutline(square, 100), '縮められるはずの量で null');
  assert.ok(signedArea(insetOutline(square, 100)!) > 0, '向きが変わった');
  assert.equal(insetOutline(square, 600), null, '潰れても null にならない');
  assert.ok(maxInsetOf(square) > 400 && maxInsetOf(square) < 500, `上限 ${maxInsetOf(square)}`);
});

test('どの仕上げでも立体は閉じていて、素より小さくなる', () => {
  const plain = (() => {
    const scene = emptyScene();
    put(scene, 'box', BOX);
    return volume(facesOf(scene));
  })();
  assert.ok(Math.abs(plain - 1e9) < 1, `素の体積 ${plain}`);

  for (const kind of EDGE_KINDS) {
    const scene = emptyScene();
    put(scene, 'box', { ...BOX, edge: { kind, size: 200 } });
    const faces = facesOf(scene);
    assert.ok(closureResidual(faces) < 1e-9,
      `${kind}: 閉じていない（残差 ${closureResidual(faces)}）`);
    const v = volume(faces);
    assert.ok(v > 0 && v < plain, `${kind}: 体積 ${v}（素は ${plain}）`);
  }
});

test('テーパは上だけ細り、高さは変わらない', () => {
  const scene = emptyScene();
  put(scene, 'box', { ...BOX, edge: { kind: 'taper', size: 250 } });
  const faces = facesOf(scene);
  const zs = faces.flatMap((f) => f.points.map((p) => p.z));
  assert.equal(Math.min(...zs), 0);
  assert.equal(Math.max(...zs), 1000);
  // 下端の広がりは元のまま、上端は縮んでいる
  const spanAt = (z: number): number => {
    const xs = faces.flatMap((f) => f.points.filter((p) => Math.abs(p.z - z) < 1e-6).map((p) => p.x));
    return Math.max(...xs) - Math.min(...xs);
  };
  assert.ok(Math.abs(spanAt(0) - 1000) < 1e-6, `下端 ${spanAt(0)}`);
  assert.ok(Math.abs(spanAt(1000) - 500) < 1e-6, `上端 ${spanAt(1000)}`);
});

test('面取りと丸めは上下とも縮み、真ん中は元のまま', () => {
  for (const kind of ['chamfer', 'fillet'] as EdgeKind[]) {
    const scene = emptyScene();
    put(scene, 'box', { ...BOX, edge: { kind, size: 200 } });
    const faces = facesOf(scene);
    const spanAt = (z: number): number => {
      const xs = faces.flatMap((f) => f.points.filter((p) => Math.abs(p.z - z) < 1e-6).map((p) => p.x));
      return xs.length === 0 ? NaN : Math.max(...xs) - Math.min(...xs);
    };
    assert.ok(Math.abs(spanAt(0) - 600) < 1e-6, `${kind}: 下端 ${spanAt(0)}`);
    assert.ok(Math.abs(spanAt(1000) - 600) < 1e-6, `${kind}: 上端 ${spanAt(1000)}`);
    // **段の高さにしか頂点が無い。** 落とし終わる高さ（200）で元の幅に戻る
    assert.ok(Math.abs(spanAt(200) - 1000) < 1e-6, `${kind}: 下の落とし終わり ${spanAt(200)}`);
    assert.ok(Math.abs(spanAt(800) - 1000) < 1e-6, `${kind}: 上の落とし始め ${spanAt(800)}`);
  }
});

test('丸めは面取りより体積が大きい（膨らんでいるぶん）', () => {
  const of = (kind: EdgeKind): number => {
    const scene = emptyScene();
    put(scene, 'box', { ...BOX, edge: { kind, size: 200 } });
    return volume(facesOf(scene));
  };
  assert.ok(of('fillet') > of('chamfer'), `丸め ${of('fillet')} / 面取り ${of('chamfer')}`);
});

test('仕上げを変えると指紋が変わる', () => {
  const scene = emptyScene();
  const f = put(scene, 'box', BOX);
  const plain = fixtureFingerprint(scene, 'f');
  f.edge = { kind: 'chamfer', size: 100 };
  const chamfered = fixtureFingerprint(scene, 'f');
  assert.notEqual(chamfered, plain, '仕上げを付けても指紋が同じ');
  f.edge = { kind: 'chamfer', size: 200 };
  assert.notEqual(fixtureFingerprint(scene, 'f'), chamfered, '大きさを変えても指紋が同じ');
});

test('押し出しで出来ていない立体では何も起きない', () => {
  // 階段・スロープ・回転体は段を積む作りではない。**付けても黙って無視する**
  for (const kind of ['stair', 'slope', 'sphere', 'cone'] as FixtureKind[]) {
    const plainScene = emptyScene();
    put(plainScene, kind, { height: 1000 });
    const before = facesOf(plainScene).length;
    const scene = emptyScene();
    put(scene, kind, { height: 1000, edge: { kind: 'chamfer', size: 100 } });
    assert.equal(facesOf(scene).length, before, `${kind}: 仕上げが効いてしまった`);
  }
});

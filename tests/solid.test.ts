import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXTURE_SPECS, fixtureKindsOf, fixturePrimitives, outline,
  type Fixture, type FixtureKind,
} from '../src/core/fixture.ts';
import { buildFixtureFaces } from '../src/render3d/fixture3d.ts';
import { rayFace, type Ray3 } from '../src/render3d/ray.ts';
import { pickAt } from '../src/core/pick.ts';
import { sceneToDxf3d } from '../src/io/dxf3d.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { emptyScene, type Scene } from '../src/core/types.ts';
import { vec } from '../src/core/geometry.ts';
import { vec3, type Vec3 } from '../src/render3d/mat4.ts';
import type { Face3 } from '../src/render3d/mesh.ts';

/**
 * 汎用ソリッド（ワイヤー 5 枚目の「基本形状の挿入」）。
 *
 * **種別を足しただけで通る道は、既存のテストが見ている**——`tests/fixture.test.ts`
 * と `tests/fixture3d.test.ts` は `FIXTURE_KINDS` を回しているので、輪郭の向き・
 * 法線の長さ・JSON の往復・面の出どころは足した瞬間から検査されている。
 *
 * ここで見るのは、**曲がった面を自前で組んだせいで壊れうるもの**だけ:
 *
 * 1. 7 種類とも平面・3D・ピック・DXF に出る
 * 2. 立体が**水密**で、面の向きが揃っている（稜線が必ず 2 枚で逆向きに共有される）
 * 3. どの面の法線も外を向く——**裏返ると `rayFace` が背面として弾き、拾えなくなる**
 * 4. **どの視点から見ても破れない**（36 方位 × 6 仰角）
 */

const SOLIDS = fixtureKindsOf('solid');

function make(kind: FixtureKind, over: Partial<Fixture> = {}): Fixture {
  const spec = FIXTURE_SPECS[kind];
  return {
    id: `f-${kind}`, kind, x: 0, y: 0, angle: 0,
    size: { ...spec.defaultSize },
    tilt: null,
    outline: null,
    combine: null,
    edge: null,
    base: null, height: null, label: spec.defaultLabel,
    layerId: spec.defaultLayer, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(),
    ...over,
  };
}

function sceneWith(f: Fixture): Scene {
  const scene = emptyScene();
  scene.fixtures[f.id] = f;
  return scene;
}

function facesOf(f: Fixture): Face3[] {
  const out: Face3[] = [];
  buildFixtureFaces(sceneWith(f), f.id, out);
  return out;
}

test('7 種類のソリッドが揃っている', () => {
  assert.deepEqual(SOLIDS, ['box', 'prism', 'cylinder', 'cylinderH', 'cone', 'sphere', 'dome']);
  // 建築の躯体には混ざらない。通常モードのパレットはこちらだけを出す
  for (const kind of fixtureKindsOf('structure')) assert.ok(!SOLIDS.includes(kind));
});

test('どのソリッドも平面・3D・ピック・DXF に出る', () => {
  for (const kind of SOLIDS) {
    const f = make(kind, { angle: 0.4 });

    // 平面——輪郭と記号
    assert.ok(outline(f).length >= 3, `${kind}: 平面の輪郭が無い`);
    assert.ok(fixturePrimitives(f, 2.5).length > 0, `${kind}: 平面に何も出ない`);

    // 3D
    const faces = facesOf(f);
    assert.ok(faces.length > 0, `${kind}: 立体にならない`);

    // ピック——真ん中を指したら自分が返る
    const scene = sceneWith(f);
    const hit = pickAt(scene, vec(f.x, f.y), 10);
    assert.deepEqual(hit, { type: 'fixture', id: f.id }, `${kind}: 平面で拾えない`);

    // DXF（3D）——面がそのまま 3DFACE になる
    const dxf = sceneToDxf3d(scene, []);
    assert.ok(dxf.faces > 0, `${kind}: DXF に面が出ない`);
    assert.ok(dxf.text.includes('3DFACE'), `${kind}: DXF に 3DFACE が無い`);
  }
});

/** 有向の稜線を数える。`a→b` と `b→a` がちょうど 1 本ずつなら水密で向きが揃っている */
function edgeCounts(faces: Face3[]): Map<string, number> {
  const key = (p: Vec3): string => `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;
  const counts = new Map<string, number>();
  for (const face of faces) {
    for (let i = 0; i < face.points.length; i++) {
      const a = face.points[i];
      const b = face.points[(i + 1) % face.points.length];
      const k = `${key(a)}|${key(b)}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return counts;
}

test('ソリッドは水密で、面の向きが揃っている', () => {
  // **稜線はちょうど 2 枚で、互いに逆向きに共有される。** 1 枚しか無ければ穴が開き、
  // 同じ向きで 2 本あれば、隣り合う面のどちらかが裏返っている
  for (const kind of SOLIDS) {
    const counts = edgeCounts(facesOf(make(kind, { angle: 0.4 })));
    for (const [k, n] of counts) {
      assert.equal(n, 1, `${kind}: 稜線 ${k} が同じ向きに ${n} 本（面が裏返っている）`);
      const [a, b] = k.split('|');
      assert.ok(counts.has(`${b}|${a}`), `${kind}: 稜線 ${k} の相手がいない（穴が開いている）`);
    }
  }
});

/** 面の重心 */
const centroidOf = (points: Vec3[]): Vec3 => vec3(
  points.reduce((s, p) => s + p.x, 0) / points.length,
  points.reduce((s, p) => s + p.y, 0) / points.length,
  points.reduce((s, p) => s + p.z, 0) / points.length,
);

test('どの面の法線も外を向く', () => {
  // **裏返ると `rayFace` が背面として弾き、そのソリッドが 3D で拾えなくなる。**
  // 凸なので「立体の中心から面の重心へ向かう向き」と法線が同じ側にあればよい
  for (const kind of SOLIDS) {
    const faces = facesOf(make(kind, { angle: 0.4 }));
    const center = centroidOf(faces.flatMap((f) => f.points));
    for (const face of faces) {
      const c = centroidOf(face.points);
      const out = { x: c.x - center.x, y: c.y - center.y, z: c.z - center.z };
      const d = face.normal.x * out.x + face.normal.y * out.y + face.normal.z * out.z;
      assert.ok(d > 0, `${kind}: 法線が内を向いている面がある (${d.toFixed(1)})`);
    }
  }
});

test('ソリッド単体はどの視点からでも破れない（36 方位 × 6 仰角）', () => {
  // **表を向いた面がちょうど 1 枚だけ交わる。** 7 種類とも凸なので、外から
  // 中心へ向けたレイは必ず 1 回だけ「入って」くる。2 枚なら面が重なって
  // 塗り順で勝ち負けが起き、0 枚なら法線が裏返っていてピックが素通りする
  for (const kind of SOLIDS) {
    const faces = facesOf(make(kind, { angle: 0.4 }));
    const center = centroidOf(faces.flatMap((f) => f.points));
    const reach = 50000;

    for (let i = 0; i < 36; i++) {
      // **3.7 度ずらす。** 真正面から辺や極を射ると、1 本のレイが 2 枚の面の
      // 境目に当たって数え方が変わる。視点の破れとは別の話なので避ける
      const az = ((i * 10 + 3.7) * Math.PI) / 180;
      for (const deg of [-70, -40, -12, 12, 40, 70]) {
        const el = (deg * Math.PI) / 180;
        const d = vec3(
          Math.cos(el) * Math.cos(az),
          Math.cos(el) * Math.sin(az),
          Math.sin(el),
        );
        const ray: Ray3 = {
          origin: vec3(center.x + d.x * reach, center.y + d.y * reach, center.z + d.z * reach),
          direction: vec3(-d.x, -d.y, -d.z),
        };
        const front = faces.filter((face) => rayFace(ray, face, 1) !== null).length;
        assert.equal(front, 1, `${kind}: 方位 ${i * 10 + 3.7}° 仰角 ${deg}° で表の面が ${front} 枚`);
      }
    }
  }
});

test('球は 24 × 12 の帯で出来ている', () => {
  // 面の数はソートの負荷に直に効くので、増えたら気づけるようにしておく。
  // 上下の極では四角形が三角形に潰れるが、帯の数は変わらない
  assert.equal(facesOf(make('sphere')).length, 24 * 12);
});

test('高さを変えると球は縦に伸び、直径は幅のまま', () => {
  const faces = facesOf(make('sphere', { height: 1200 }));
  const zs = faces.flatMap((f) => f.points.map((p) => p.z));
  const xs = faces.flatMap((f) => f.points.map((p) => p.x));
  assert.ok(Math.abs((Math.max(...zs) - Math.min(...zs)) - 1200) < 1, '高さが効いていない');
  assert.ok(Math.abs((Math.max(...xs) - Math.min(...xs)) - 600) < 10, '直径が幅と違う');
});

test('寝かせた円筒は長さが奥行、断面の径が幅と高さ', () => {
  // 向きを 0 にすればローカルの y がワールドの y。長さは `size.h` で決まる
  const faces = facesOf(make('cylinderH', { angle: 0 }));
  const span = (get: (p: Vec3) => number): number => {
    const vs = faces.flatMap((f) => f.points.map(get));
    return Math.max(...vs) - Math.min(...vs);
  };
  assert.ok(Math.abs(span((p) => p.y) - 1200) < 1, `長さが ${span((p) => p.y)}`);
  assert.ok(Math.abs(span((p) => p.x) - 600) < 10, `断面の横径が ${span((p) => p.x)}`);
  assert.ok(Math.abs(span((p) => p.z) - 600) < 10, `断面の縦径が ${span((p) => p.z)}`);
});

test('円錐は頂点で尖り、蓋が 1 枚だけ付く', () => {
  const faces = facesOf(make('cone'));
  const tris = faces.filter((f) => f.points.length === 3);
  assert.equal(tris.length, 24, `側面が ${tris.length} 枚`);
  // 底の蓋 1 枚。頂点の側には蓋を張らない（面積 0 の面を作らないため）
  assert.equal(faces.length - tris.length, 1, '蓋の数が違う');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_KINDS, FIXTURE_SPECS, STEP_DEPTH, verticalRange, type Fixture, type FixtureKind } from '../src/core/fixture.ts';
import { buildFixtureFaces } from '../src/render3d/fixture3d.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { activeLevel, DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { emptyScene, type Scene } from '../src/core/types.ts';
import type { Face3 } from '../src/render3d/mesh.ts';

function sceneWith(kind: FixtureKind, over: Partial<Fixture> = {}): { scene: Scene; id: string } {
  const scene = emptyScene();
  const spec = FIXTURE_SPECS[kind];
  const id = 'f1';
  scene.fixtures[id] = {
    id, kind, x: 0, y: 0, angle: 0,
    size: { ...spec.defaultSize },
    base: null, height: null, label: spec.defaultLabel,
    layerId: spec.defaultLayer, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(),
    ...over,
  };
  return { scene, id };
}

const facesOf = (kind: FixtureKind, over: Partial<Fixture> = {}): Face3[] => {
  const { scene, id } = sceneWith(kind, over);
  const out: Face3[] = [];
  buildFixtureFaces(scene, id, out);
  return out;
};

test('立体になる種別は面を出し、吹抜は出さない', () => {
  for (const kind of FIXTURE_KINDS) {
    const faces = facesOf(kind);
    if (FIXTURE_SPECS[kind].solid) assert.ok(faces.length > 0, `${kind} が立たない`);
    else assert.equal(faces.length, 0, `${kind} は穴なので立ってはいけない`);
  }
});

test('どの面も有限の座標と単位法線を持つ', () => {
  // 3D のテストスタブが非有限数で例外を投げるのと同じ防ぎ方を、面の側でも持つ
  for (const kind of FIXTURE_KINDS) {
    for (const f of facesOf(kind, { angle: 0.7 })) {
      for (const p of f.points) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), `${kind} に非有限の点`);
      }
      const n = Math.hypot(f.normal.x, f.normal.y, f.normal.z);
      assert.ok(Math.abs(n - 1) < 1e-6, `${kind} の法線の長さが ${n}`);
    }
  }
});

test('面はすべてその構造を指す', () => {
  for (const kind of FIXTURE_KINDS) {
    for (const f of facesOf(kind)) {
      assert.equal(f.ref?.type, 'fixture', `${kind} の面の出どころが違う`);
      assert.equal(f.ref?.id, 'f1');
      assert.equal(f.levelId, DEFAULT_LEVEL_ID);
    }
  }
});

test('階段は 2D の段板と同じ数の段で立つ', () => {
  // **平面の記号と立体がずれない。** どちらも同じ式で段数を決めている
  const size = FIXTURE_SPECS.stair.defaultSize;
  const count = Math.max(2, Math.round(size.h / STEP_DEPTH));
  const faces = facesOf('stair');
  // 1 段は 4 側面 + 上面 + 下面 = 6 枚
  assert.equal(faces.length, count * 6, `段数が合わない (${faces.length} 枚)`);
});

test('階段は下から上へ上がる', () => {
  const faces = facesOf('stair');
  const level = activeLevel(emptyScene());
  const { z0, z1 } = verticalRange(
    { ...sceneWith('stair').scene.fixtures.f1 },
    level,
  );
  const tops = faces.map((f) => Math.max(...f.points.map((p) => p.z)));
  assert.ok(Math.min(...tops) < z1 - 1, '全部の段が同じ高さになっている');
  assert.ok(Math.abs(Math.max(...tops) - z1) < 1e-6, '最上段が階高に届いていない');
  assert.ok(Math.min(...faces.flatMap((f) => f.points.map((p) => p.z))) >= z0 - 1e-6, '床より下に出ている');
});

test('スロープは斜めの面を持つ', () => {
  const faces = facesOf('slope');
  // 真上でも真横でもない法線が 1 枚だけある＝勾配の面
  const slanted = faces.filter((f) => Math.abs(f.normal.z) > 1e-6 && Math.abs(f.normal.z) < 1 - 1e-6);
  assert.equal(slanted.length, 1, `斜めの面が ${slanted.length} 枚`);
});

test('柱と梁は壁と同じ色で出る（躯体だから）', () => {
  for (const kind of ['column', 'roundColumn', 'beam'] as const) {
    for (const f of facesOf(kind)) assert.equal(f.bucket, 'wall', `${kind} の層が違う`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXTURE_KINDS,
  FIXTURE_SPECS,
  fixturePrimitives,
  outline,
  specOf,
  verticalRange,
  type Fixture,
  type FixtureKind,
} from '../src/core/fixture.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { activeLevel, DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { emptyScene } from '../src/core/types.ts';
import { signedArea } from '../src/core/geometry.ts';
import { deserialize, serialize } from '../src/io/scene.ts';

function make(kind: FixtureKind, over: Partial<Fixture> = {}): Fixture {
  const spec = FIXTURE_SPECS[kind];
  return {
    id: `f-${kind}`,
    kind,
    x: 1000,
    y: 2000,
    angle: 0,
    size: { ...spec.defaultSize },
    base: null,
    height: null,
    label: spec.defaultLabel,
    layerId: spec.defaultLayer,
    levelId: DEFAULT_LEVEL_ID,
    attrs: defaultAttrs(),
    ...over,
  };
}

test('どの種別も輪郭が反時計回りの単純多角形になる', () => {
  // 押し出しは向きを頼りに外向きの法線を決める。逆だと内側が見える
  for (const kind of FIXTURE_KINDS) {
    const poly = outline(make(kind));
    assert.ok(poly.length >= 3, `${kind} の輪郭が足りない`);
    assert.ok(signedArea(poly) > 0, `${kind} の輪郭が時計回り`);
  }
});

test('円柱は向きを変えても形が変わらない', () => {
  const a = outline(make('roundColumn', { angle: 0 }));
  const b = outline(make('roundColumn', { angle: 0.7 }));
  const radius = (poly: ReturnType<typeof outline>) =>
    poly.map((p) => Math.hypot(p.x - 1000, p.y - 2000));
  const ra = radius(a);
  const rb = radius(b);
  for (const r of [...ra, ...rb]) assert.ok(Math.abs(r - 150) < 1, `半径が ${r}`);
});

test('梁は天井から下がり、階高に追従する', () => {
  // **ここが `BLOCK_HEIGHTS` では書けなかったこと。**
  // ブロックは定義 id ごとの固定値で、階高が変わっても動かない
  const scene = emptyScene();
  const level = activeLevel(scene);
  const beam = make('beam');

  const at2400 = verticalRange(beam, level);
  assert.equal(at2400.z1, level.floorZ + level.wallHeight, '梁の上端が天井に付いていない');

  level.wallHeight = 3000;
  const at3000 = verticalRange(beam, level);
  assert.equal(at3000.z1, level.floorZ + 3000, '階高を上げても梁が追従しない');
  assert.equal(at3000.z1 - at3000.z0, at2400.z1 - at2400.z0, 'せいまで変わっている');
});

test('柱は階高いっぱいに立つ', () => {
  const scene = emptyScene();
  const level = activeLevel(scene);
  for (const kind of ['column', 'roundColumn'] as const) {
    const { z0, z1 } = verticalRange(make(kind), level);
    assert.equal(z0, level.floorZ);
    assert.equal(z1, level.floorZ + level.wallHeight);
  }
});

test('上書きした高さは既定より優先される', () => {
  const level = activeLevel(emptyScene());
  const { z0, z1 } = verticalRange(make('column', { base: 100, height: 900 }), level);
  assert.equal(z0, level.floorZ + 100);
  assert.equal(z1, level.floorZ + 1000);
});

test('吹抜は立体にならず、文字が付く', () => {
  assert.equal(FIXTURE_SPECS.void.solid, false, '穴なのに立体になっている');
  assert.equal(FIXTURE_SPECS.void.defaultLabel, '吹抜');
  const prims = fixturePrimitives(make('void'), 2.5);
  assert.ok(prims.some((p) => p.kind === 'text' && p.text === '吹抜'), '文字が出ていない');
});

test('柱だけが塗りつぶしになる', () => {
  // JIS の柱は塗る。梁と階段は輪郭だけ
  for (const kind of FIXTURE_KINDS) {
    const filled = specOf(make(kind)).filled;
    assert.equal(filled, kind === 'column' || kind === 'roundColumn', `${kind} の塗りが違う`);
  }
});

test('構造が JSON の往復を生き延びる', () => {
  const scene = emptyScene();
  for (const kind of FIXTURE_KINDS) {
    scene.fixtures[`f-${kind}`] = make(kind, {
      id: `f-${kind}`, x: 123, y: 456, angle: 0.5, base: 50, height: 1234, label: `名${kind}`,
    });
  }
  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.deepEqual(Object.keys(back.fixtures).sort(), Object.keys(scene.fixtures).sort());
  for (const [id, f] of Object.entries(scene.fixtures)) {
    assert.deepEqual(back.fixtures[id], f, `${id} が往復で変わった`);
  }
});

test('読み込みで壊れた構造を捨てる', () => {
  const raw = {
    format: 'minicad', version: 10, unit: 'mm',
    scene: {
      fixtures: {
        ok: { kind: 'column', x: 0, y: 0 },
        badKind: { kind: 'ufo', x: 0, y: 0 },
        noPos: { kind: 'column' },
      },
    },
  };
  const scene = deserialize(raw);
  assert.deepEqual(Object.keys(scene.fixtures), ['ok']);
  // 省略した欄は種別の既定に落ちる
  assert.deepEqual(scene.fixtures.ok.size, FIXTURE_SPECS.column.defaultSize);
  assert.equal(scene.fixtures.ok.base, null);
});

test('円柱は奥行が別の値で書かれていても直径に揃う', () => {
  const raw = {
    format: 'minicad', version: 10, unit: 'mm',
    scene: { fixtures: { c: { kind: 'roundColumn', x: 0, y: 0, size: { w: 400, h: 999 } } } },
  };
  const f = deserialize(raw).fixtures.c;
  assert.equal(f.size.w, 400);
  assert.equal(f.size.h, 400, '直径と奥行が食い違っている');
});

test('吹抜は部屋の床面積を食うが、内法面積は変えない', async () => {
  const { detectRooms } = await import('../src/core/rooms.ts');
  const { findOrCreateNode, addWall } = await import('../src/core/ops.ts');
  const { vec } = await import('../src/core/geometry.ts');

  const scene = emptyScene();
  const c = [vec(0, 0), vec(5000, 0), vec(5000, 4000), vec(0, 4000)].map((p) => findOrCreateNode(scene, p));
  for (let i = 0; i < 4; i++) addWall(scene, c[i], c[(i + 1) % 4], 100);

  const before = detectRooms(scene);
  assert.equal(before.length, 1);
  assert.equal(before[0].voidArea, 0);
  assert.equal(before[0].floorArea, before[0].innerArea);

  // 2000 × 2000 の吹抜を真ん中に置く
  scene.fixtures.v = make('void', { id: 'v', x: 2500, y: 2000, size: { w: 2000, h: 2000 } });
  const after = detectRooms(scene);
  assert.equal(after[0].innerArea, before[0].innerArea, '内法面積まで変わっている');
  assert.ok(Math.abs(after[0].voidArea - 4) < 1e-6, `吹抜が ${after[0].voidArea} m²`);
  assert.ok(Math.abs(after[0].floorArea - (before[0].innerArea - 4)) < 1e-6, '床面積が引けていない');
});

test('部屋の外の吹抜は数えない', async () => {
  const { detectRooms } = await import('../src/core/rooms.ts');
  const { findOrCreateNode, addWall } = await import('../src/core/ops.ts');
  const { vec } = await import('../src/core/geometry.ts');

  const scene = emptyScene();
  const c = [vec(0, 0), vec(5000, 0), vec(5000, 4000), vec(0, 4000)].map((p) => findOrCreateNode(scene, p));
  for (let i = 0; i < 4; i++) addWall(scene, c[i], c[(i + 1) % 4], 100);
  scene.fixtures.v = make('void', { id: 'v', x: 20000, y: 20000 });
  assert.equal(detectRooms(scene)[0].voidArea, 0);
});

test('立体になる構造は床を食わない', async () => {
  // 柱は床の上に立つ。穴ではない
  const { detectRooms } = await import('../src/core/rooms.ts');
  const { findOrCreateNode, addWall } = await import('../src/core/ops.ts');
  const { vec } = await import('../src/core/geometry.ts');

  const scene = emptyScene();
  const c = [vec(0, 0), vec(5000, 0), vec(5000, 4000), vec(0, 4000)].map((p) => findOrCreateNode(scene, p));
  for (let i = 0; i < 4; i++) addWall(scene, c[i], c[(i + 1) % 4], 100);
  scene.fixtures.k = make('column', { id: 'k', x: 2500, y: 2000 });
  assert.equal(detectRooms(scene)[0].voidArea, 0);
});

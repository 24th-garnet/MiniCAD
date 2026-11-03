import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_SPECS, isTilted, toWorld, toWorld3, type Fixture, type FixtureKind } from '../src/core/fixture.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { vec, type Vec } from '../src/core/geometry.ts';
import { emptyScene, type Scene } from '../src/core/types.ts';

/**
 * 立体の傾き（第 5 版の 1 段目）。
 *
 * **ワイヤーのオブジェクト編集パネルが回転 X / Y / Z の 3 行を持っている。**
 * z は `angle` が持っているので、足すのは x と y。
 *
 * ここでいちばん大事なのは **「傾きなしの道が、入れる前と同じ」** こと。
 * 柱・階段・出窓・ソリッド・押し出し・ブーリアン・稜線の仕上げが既に動いていて、
 * 800 件近いテストがそれを押さえている。
 */

function make(kind: FixtureKind, over: Partial<Fixture> = {}): Fixture {
  const spec = FIXTURE_SPECS[kind];
  return {
    id: 'f', kind, x: 0, y: 0, angle: 0, tilt: null,
    size: { ...spec.defaultSize }, outline: null, combine: null, edge: null,
    base: 0, height: 1000, label: spec.defaultLabel,
    layerId: spec.defaultLayer, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(),
    ...over,
  };
}

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

test('傾きなしなら、これまでと同じ平面の点を返す', () => {
  // **ここが土台。** 既にあるものに回帰が出ないことを、式で押さえる
  for (const angle of [0, 0.7, Math.PI / 2, -1.3]) {
    const f = make('box', { x: 1200, y: -800, angle });
    for (const p of [vec(0, 0), vec(300, 0), vec(-250, 450)]) {
      const got = toWorld(f, p);
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      assert.ok(near(got.x, p.x * c - p.y * s + 1200), `x が違う (angle=${angle})`);
      assert.ok(near(got.y, p.x * s + p.y * c - 800), `y が違う (angle=${angle})`);
    }
  }
});

test('傾きなしなら、3 次元でも z が素通しになる', () => {
  const f = make('box', { x: 500, y: 500, angle: 0.4 });
  for (const z of [0, 600, -200]) {
    const got = toWorld3(f, vec(100, 200), z);
    assert.equal(got.z, z, '高さが変わった');
    const flat = toWorld(f, vec(100, 200));
    assert.ok(near(got.x, flat.x) && near(got.y, flat.y), '平面の位置が 2D と食い違う');
  }
});

test('x 軸まわりに 90 度倒すと、ローカルの y が高さになる', () => {
  const f = make('box', { tilt: { x: Math.PI / 2, y: 0 } });
  const got = toWorld3(f, vec(0, 100), 0);
  assert.ok(near(got.x, 0), `x が ${got.x}`);
  assert.ok(near(got.y, 0, 1e-9), `y が ${got.y}`);
  assert.ok(near(got.z, 100), `z が ${got.z}`);
});

test('y 軸まわりに 90 度倒すと、ローカルの高さが x になる', () => {
  const f = make('box', { tilt: { x: 0, y: Math.PI / 2 } });
  const got = toWorld3(f, vec(0, 0), 100);
  assert.ok(near(got.x, 100), `x が ${got.x}`);
  assert.ok(near(got.z, 0, 1e-9), `z が ${got.z}`);
});

test('傾けたあとに z 軸でも回る（順序が決まっている）', () => {
  // ローカル → ワールドは Rz(angle) · Ry(tilt.y) · Rx(tilt.x)。
  // y で倒してから z で 90 度回すと、x へ出たものが y へ移る
  const f = make('box', { angle: Math.PI / 2, tilt: { x: 0, y: Math.PI / 2 } });
  const got = toWorld3(f, vec(0, 0), 100);
  assert.ok(near(got.x, 0, 1e-9), `x が ${got.x}`);
  assert.ok(near(got.y, 100), `y が ${got.y}`);
});

test('傾きは長さを変えない（回転なので）', () => {
  const f = make('box', { tilt: { x: 0.6, y: -0.9 }, angle: 1.1, x: 0, y: 0 });
  const cases: { p: Vec; z: number }[] = [
    { p: vec(300, 400), z: 0 },
    { p: vec(0, 0), z: 500 },
    { p: vec(-120, 80), z: -90 },
  ];
  for (const { p, z } of cases) {
    const got = toWorld3(f, p, z);
    const before = Math.hypot(p.x, p.y, z);
    const after = Math.hypot(got.x, got.y, got.z);
    assert.ok(near(before, after, 1e-6), `${before} → ${after}`);
  }
});

test('0 と 0 の傾きは「傾きなし」と同じ', () => {
  assert.equal(isTilted(make('box')), false);
  assert.equal(isTilted(make('box', { tilt: { x: 0, y: 0 } })), false);
  assert.equal(isTilted(make('box', { tilt: { x: 0.1, y: 0 } })), true);
});

function sceneWith(f: Fixture): Scene {
  const scene = emptyScene();
  scene.fixtures[f.id] = f;
  return scene;
}

test('傾きが JSON の往復を生き延びる', () => {
  const scene = sceneWith(make('box', { tilt: { x: 0.3, y: -1.2 } }));
  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.deepEqual(back.fixtures.f, scene.fixtures.f, '往復で変わった');
});

test('欄が無い古いファイルは傾きなしになる', () => {
  // **移行の処理を持たない。** 欄が無ければ null に倒れる
  const scene = sceneWith(make('box'));
  const raw = JSON.parse(JSON.stringify(serialize(scene)));
  delete raw.scene.fixtures.f.tilt;
  assert.equal(deserialize(raw).fixtures.f.tilt, null);

  // 壊れた値も傾きなしへ
  raw.scene.fixtures.f.tilt = 'ななめ';
  assert.equal(deserialize(raw).fixtures.f.tilt, null);
  raw.scene.fixtures.f.tilt = { x: 0, y: 0 };
  assert.equal(deserialize(raw).fixtures.f.tilt, null, '0 と 0 は畳む');
});

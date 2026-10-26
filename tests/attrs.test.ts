import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultAttrs, hasAttrs, isTakeoffMode, type Attrs } from '../src/core/attrs.ts';
import { emptyScene } from '../src/core/types.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { sampleScene } from '../src/io/sample.ts';
import { vec } from '../src/core/geometry.ts';
import { explodeInstance } from '../src/core/block.ts';

/** 欄を 1 つ足したらここが落ちる。足したことに気づかずに通らないようにする */
const FILLED: Attrs = {
  groupId: 'g1',
  color: '#ff0000',
  materialRef: 'host-material-42',
  takeoff: 'excluded',
  symbolId: 'sym-7',
  symbolVersion: 3,
};

test('既定の属性はすべて null', () => {
  const a = defaultAttrs();
  assert.deepEqual(a, {
    groupId: null,
    color: null,
    materialRef: null,
    takeoff: null,
    symbolId: null,
    symbolVersion: null,
  });
  assert.equal(hasAttrs(a), false);
});

test('属性の欄は 5 つで、全部 FILLED が埋めている', () => {
  // 欄を足したら FILLED も足す。足し忘れると往復のテストが素通りする
  assert.deepEqual(Object.keys(defaultAttrs()).sort(), Object.keys(FILLED).sort());
  assert.equal(hasAttrs(FILLED), true);
});

test('属性が JSON の往復で全欄保たれる', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const wall = addWall(scene, a, b, 120)!;
  wall.attrs = { ...FILLED };

  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.deepEqual(back.walls[wall.id].attrs, FILLED, '書けるのに読めない欄がある');
});

test('属性を持たない旧ファイルは全欄 null に落ちる', () => {
  const scene = sampleScene();
  const raw = JSON.parse(JSON.stringify(serialize(scene)));
  for (const w of Object.values(raw.scene.walls) as Record<string, unknown>[]) delete w.attrs;
  for (const o of Object.values(raw.scene.openings) as Record<string, unknown>[]) delete o.attrs;
  for (const i of Object.values(raw.scene.instances) as Record<string, unknown>[]) delete i.attrs;
  for (const s of Object.values(raw.scene.shapes) as Record<string, unknown>[]) delete s.attrs;

  const back = deserialize(raw);
  const all = [
    ...Object.values(back.walls),
    ...Object.values(back.openings),
    ...Object.values(back.instances),
    ...Object.values(back.shapes),
  ];
  assert.ok(all.length > 20, '前提: サンプルに十分な実体がある');
  for (const e of all) assert.deepEqual(e.attrs, defaultAttrs(), `${e.id} の属性が既定でない`);
});

test('知らない積算区分は null に落ちる', () => {
  // 閉じた語彙。黙って通すと、その行が何を名乗っているか決まらなくなる
  assert.equal(isTakeoffMode('included'), true);
  assert.equal(isTakeoffMode('excluded'), true);
  assert.equal(isTakeoffMode('対象'), false);
  assert.equal(isTakeoffMode(1), false);

  const scene = emptyScene();
  const wall = addWall(scene, findOrCreateNode(scene, vec(0, 0)), findOrCreateNode(scene, vec(1000, 0)), 120)!;
  const raw = JSON.parse(JSON.stringify(serialize(scene)));
  (raw.scene.walls[wall.id] as Record<string, unknown>).attrs = { takeoff: '対象' };

  const back = deserialize(raw);
  assert.equal(back.walls[wall.id].attrs.takeoff, null);
});

test('空文字は指定なしとして読む', () => {
  const scene = emptyScene();
  const wall = addWall(scene, findOrCreateNode(scene, vec(0, 0)), findOrCreateNode(scene, vec(1000, 0)), 120)!;
  const raw = JSON.parse(JSON.stringify(serialize(scene)));
  (raw.scene.walls[wall.id] as Record<string, unknown>).attrs = { materialRef: '', color: '' };

  const back = deserialize(raw);
  assert.equal(back.walls[wall.id].attrs.materialRef, null);
  assert.equal(back.walls[wall.id].attrs.color, null);
});

test('ブロックを分解すると挿入側の属性が図形に移る', () => {
  // 定義の中の属性は意味を持たない。人が見ているのは挿入したものの素材
  const scene = sampleScene();
  const inst = Object.values(scene.instances)[0];
  inst.attrs = { ...FILLED };

  const ids = explodeInstance(scene, inst.id);
  assert.ok(ids.length > 0, '分解できていない');
  for (const id of ids) {
    assert.deepEqual(scene.shapes[id].attrs, FILLED, '分解した図形に属性が移っていない');
  }
});

test('シンボルの版は id があるときだけ残る', () => {
  // 版だけあって id が無いものは、どのシンボルの版か決まらない
  const scene = sampleScene();
  const wallId = Object.keys(scene.walls)[0];
  scene.walls[wallId].attrs = { ...FILLED, symbolId: null, symbolVersion: 5 };
  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.equal(back.walls[wallId].attrs.symbolVersion, null);

  scene.walls[wallId].attrs = { ...FILLED, symbolId: 'sym-1', symbolVersion: 5 };
  const kept = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.equal(kept.walls[wallId].attrs.symbolVersion, 5);
});

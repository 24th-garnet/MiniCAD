import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assemblyFromScene,
  defineAssembly,
  isEmptyBody,
  stampAssembly,
  stampedBy,
  stampedVersions,
} from '../src/core/assembly.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { vec } from '../src/core/geometry.ts';
import { emptyScene, type EntityRef, type Scene } from '../src/core/types.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { makeOpening } from './make.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { FIXTURE_SPECS } from '../src/core/fixture.ts';
import { DEFAULT_LEVEL_ID } from '../src/core/level.ts';

/** 2000 × 3000 の囲いと、その中に柱 1 本 */
function roomScene(): { scene: Scene; refs: EntityRef[] } {
  const scene = emptyScene();
  const c = [vec(0, 0), vec(2000, 0), vec(2000, 3000), vec(0, 3000)].map((p) => findOrCreateNode(scene, p));
  const walls = [];
  for (let i = 0; i < 4; i++) walls.push(addWall(scene, c[i], c[(i + 1) % 4], 100)!);
  const op = makeOpening(walls[0].id, { kind: 'door', offset: 1000, width: 800 });
  scene.openings[op.id] = op;
  scene.fixtures.k = {
    id: 'k', kind: 'column', x: 1000, y: 1500, angle: 0,
    size: { ...FIXTURE_SPECS.column.defaultSize }, base: null, height: null, label: '',
    layerId: FIXTURE_SPECS.column.defaultLayer, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(),
  };
  const refs: EntityRef[] = [
    ...walls.map((w) => ({ type: 'wall' as const, id: w.id })),
    { type: 'fixture', id: 'k' },
  ];
  return { scene, refs };
}

test('選択からシンボルを作ると、基点が中心に寄る', () => {
  const { scene, refs } = roomScene();
  const a = defineAssembly(scene, refs, '2LDK')!;
  assert.ok(a);
  assert.equal(a.version, 1);
  assert.equal(Object.keys(a.body.walls).length, 4);
  assert.equal(Object.keys(a.body.openings).length, 1, '壁に載る建具が入っていない');

  const xs = Object.values(a.body.nodes).map((n) => n.x);
  const ys = Object.values(a.body.nodes).map((n) => n.y);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [-1000, 1000]);
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [-1500, 1500]);
});

test('置くと実体になり、部屋として検出される', () => {
  // **ここがスタンプの効きどころ。** 本物の壁になるので部屋検出は無改造で効く
  const { scene, refs } = roomScene();
  const a = defineAssembly(scene, refs, '2LDK')!;

  const empty = emptyScene();
  assert.equal(detectRooms(empty).length, 0);
  const placed = stampAssembly(empty, a, vec(10000, 10000), 0, empty.activeLevelId);

  assert.equal(placed.length, 6, `置いたものが ${placed.length} 個`);
  assert.equal(Object.keys(empty.walls).length, 4);
  assert.equal(Object.keys(empty.openings).length, 1);
  assert.equal(detectRooms(empty).length, 1, '置いた壁が部屋にならない');
});

test('置いたものは由来と版を覚えている', () => {
  const { scene, refs } = roomScene();
  const a = defineAssembly(scene, refs, '2LDK')!;
  const empty = emptyScene();
  stampAssembly(empty, a, vec(0, 0), 0, empty.activeLevelId);

  const stamped = stampedBy(empty, a.id);
  assert.equal(stamped.length, 6);
  assert.deepEqual([...stampedVersions(empty, a.id)], [1]);

  // 別のシンボルの id では拾わない
  assert.deepEqual(stampedBy(empty, 'ほか'), []);
});

test('回して置くと、中身も一緒に回る', () => {
  const { scene, refs } = roomScene();
  const a = defineAssembly(scene, refs, '2LDK')!;
  const empty = emptyScene();
  stampAssembly(empty, a, vec(0, 0), Math.PI / 2, empty.activeLevelId);

  // 2000 × 3000 が 3000 × 2000 になる
  const xs = Object.values(empty.nodes).map((n) => n.x);
  const ys = Object.values(empty.nodes).map((n) => n.y);
  assert.ok(Math.abs((Math.max(...xs) - Math.min(...xs)) - 3000) < 1e-6);
  assert.ok(Math.abs((Math.max(...ys) - Math.min(...ys)) - 2000) < 1e-6);
  // 構造も回る
  assert.ok(Math.abs(Object.values(empty.fixtures)[0].angle - Math.PI / 2) < 1e-6);
});

test('置くたびに新しい id になる（入れ子にならない）', () => {
  const { scene, refs } = roomScene();
  const a = defineAssembly(scene, refs, '2LDK')!;
  const empty = emptyScene();
  stampAssembly(empty, a, vec(0, 0), 0, empty.activeLevelId);
  stampAssembly(empty, a, vec(10000, 0), 0, empty.activeLevelId);
  assert.equal(Object.keys(empty.walls).length, 8);
  assert.equal(Object.keys(empty.nodes).length, 8, 'ノードが共有されている');
  assert.equal(detectRooms(empty).length, 2);
});

test('図形も構造も無い選択からはシンボルを作らない', () => {
  const scene = emptyScene();
  assert.equal(defineAssembly(scene, [], 'から'), null);
});

test('図面まるごとからシンボルを作れる（ホストのカタログの形）', () => {
  const { scene } = roomScene();
  const a = assemblyFromScene(scene, 'host-2ldk', '2LDK ベース図面')!;
  assert.ok(a);
  assert.equal(a.id, 'host-2ldk');
  assert.equal(Object.keys(a.body.walls).length, 4);
  assert.ok(!isEmptyBody(a.body));
});

test('中身が空の図面からはシンボルを作らない', () => {
  assert.equal(assemblyFromScene(emptyScene(), 'x', 'から'), null);
});

test('シンボルが JSON の往復を生き延びる', () => {
  const { scene, refs } = roomScene();
  const a = defineAssembly(scene, refs, '2LDK')!;
  scene.assemblies[a.id] = a;

  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  const got = back.assemblies[a.id];
  assert.ok(got, 'シンボルが消えた');
  assert.equal(got.name, '2LDK');
  assert.equal(Object.keys(got.body.walls).length, 4);
  assert.equal(Object.keys(got.body.openings).length, 1);
  assert.equal(Object.keys(got.body.fixtures).length, 1);
});

test('行き場のない壁を持つシンボルは読み込みで落ちる', () => {
  // 両端が中身のノードを指していない壁は、置いた瞬間に行き場がない
  const raw = {
    format: 'minicad', version: 11, unit: 'mm',
    scene: {
      assemblies: {
        bad: { name: 'X', version: 1, body: { nodes: {}, walls: { w: { a: 'n1', b: 'n2' } } } },
      },
    },
  };
  assert.deepEqual(Object.keys(deserialize(raw).assemblies), []);
});

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
    size: { ...FIXTURE_SPECS.column.defaultSize }, outline: null, base: null, height: null, label: '',
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

test('置いた箇所を覚えていて、押し直しの前に何が変わるか言える', async () => {
  const { restampReport, restampAssembly, updateAssembly } = await import('../src/core/assembly.ts');

  const { scene, refs } = roomScene();
  const a = defineAssembly(scene, refs, '2LDK')!;
  const target = emptyScene();
  target.assemblies[a.id] = a;
  stampAssembly(target, a, vec(0, 0), 0, target.activeLevelId);
  stampAssembly(target, a, vec(10000, 0), 0, target.activeLevelId);

  assert.equal(Object.keys(target.stamps).length, 2, '置いた箇所が覚えられていない');

  // まだ全部最新なので、押し直すものは無い
  const fresh = restampReport(target, a.id);
  assert.equal(fresh.stamps.length, 0);
  assert.equal(fresh.upToDate, 2);
  assert.equal(restampAssembly(target, a.id), 0, '最新なのに押し直した');

  // 1 箇所目を編集して、その形を新しい版にする
  const first = Object.values(target.stamps)[0];
  const mine = Object.values(target.walls).filter((w) => w.attrs.stampId === first.id);
  for (const w of mine) w.thickness = 200;
  assert.ok(updateAssembly(target, a.id, mine.map((w) => ({ type: 'wall' as const, id: w.id }))));
  assert.equal(target.assemblies[a.id].version, 2);

  // **押し直す前に、何箇所・何個が置き換わるか言える**
  const report = restampReport(target, a.id);
  assert.equal(report.stamps.length, 2, '両方とも古い版のまま');
  assert.ok(report.entities > 0);
});

test('押し直すと古い版の箇所がいまの版になる', async () => {
  const { restampAssembly, updateAssembly, restampReport } = await import('../src/core/assembly.ts');
  const { detectRooms } = await import('../src/core/rooms.ts');

  const { scene, refs } = roomScene();
  const a = defineAssembly(scene, refs, '2LDK')!;
  const target = emptyScene();
  target.assemblies[a.id] = a;
  stampAssembly(target, a, vec(0, 0), 0, target.activeLevelId);
  stampAssembly(target, a, vec(10000, 0), 0, target.activeLevelId);

  const first = Object.values(target.stamps)[0];
  const mine = Object.values(target.walls).filter((w) => w.attrs.stampId === first.id);
  for (const w of mine) w.thickness = 200;
  updateAssembly(target, a.id, mine.map((w) => ({ type: 'wall' as const, id: w.id })));

  const removed = restampAssembly(target, a.id);
  assert.ok(removed > 0);

  // **全部が新しい厚みになる**
  const thicknesses = new Set(Object.values(target.walls).map((w) => w.thickness));
  assert.deepEqual([...thicknesses], [200], `壁厚が ${[...thicknesses]}`);
  assert.equal(Object.keys(target.walls).length, 8, '壁の数が変わった');
  assert.equal(detectRooms(target).length, 2, '押し直したら部屋が壊れた');
  assert.deepEqual([...stampedVersions(target, a.id)], [2]);
  assert.equal(restampReport(target, a.id).stamps.length, 0, '押し直したのに古いまま');
});

test('押し直しても行き場のないノードが残らない', async () => {
  const { restampAssembly, updateAssembly } = await import('../src/core/assembly.ts');
  const { scene, refs } = roomScene();
  const a = defineAssembly(scene, refs, '2LDK')!;
  const target = emptyScene();
  target.assemblies[a.id] = a;
  stampAssembly(target, a, vec(0, 0), 0, target.activeLevelId);

  const mine = Object.values(target.walls);
  updateAssembly(target, a.id, mine.map((w) => ({ type: 'wall' as const, id: w.id })));
  restampAssembly(target, a.id);

  const used = new Set(Object.values(target.walls).flatMap((w) => [w.a, w.b]));
  for (const id of Object.keys(target.nodes)) {
    assert.ok(used.has(id), `使われていないノード ${id} が残っている`);
  }
});

test('置いた箇所が JSON の往復を生き延びる', () => {
  const { scene, refs } = roomScene();
  const a = defineAssembly(scene, refs, '2LDK')!;
  const target = emptyScene();
  target.assemblies[a.id] = a;
  stampAssembly(target, a, vec(500, 700), 0.5, target.activeLevelId);

  const back = deserialize(JSON.parse(JSON.stringify(serialize(target))));
  const st = Object.values(back.stamps)[0];
  assert.ok(st, '置いた箇所が消えた');
  assert.equal(st.assemblyId, a.id);
  assert.equal(st.x, 500);
  assert.equal(st.angle, 0.5);
  // 置かれた実体がその箇所を指している
  assert.ok(Object.values(back.walls).every((w) => w.attrs.stampId === st.id));
});

test('置き先のシンボルが無い箇所は読み込みで落ちる', () => {
  const raw = {
    format: 'minicad', version: 11, unit: 'mm',
    scene: { stamps: { s1: { assemblyId: 'いない', x: 0, y: 0 } } },
  };
  assert.deepEqual(Object.keys(deserialize(raw).stamps), []);
});

/**
 * 以前は箇所の id を `groupId` に入れていた。人が作るグループと同じ欄なので、
 * 人がスタンプ由来の実体をグループ化すると**押し直す相手を見失う**。
 * 欄を分けたので、人のグループは押し直しに一切影響しない。
 */
test('人が作ったグループは、シンボルの押し直しに影響しない', async () => {
  const { restampReport, restampAssembly, updateAssembly } = await import('../src/core/assembly.ts');

  const { scene, refs } = roomScene();
  const a = defineAssembly(scene, refs, '2LDK')!;
  const target = emptyScene();
  target.assemblies[a.id] = a;
  stampAssembly(target, a, vec(0, 0), 0, target.activeLevelId);
  stampAssembly(target, a, vec(10000, 0), 0, target.activeLevelId);

  const first = Object.values(target.stamps)[0];
  const mine = Object.values(target.walls).filter((w) => w.attrs.stampId === first.id);
  for (const w of mine) w.thickness = 200;
  updateAssembly(target, a.id, mine.map((w) => ({ type: 'wall' as const, id: w.id })));

  // **人が全部まとめて 1 グループにする。** 昔はここで箇所の id が消えた
  for (const w of Object.values(target.walls)) w.attrs.groupId = 'g-by-hand';

  const report = restampReport(target, a.id);
  assert.equal(report.stamps.length, 2, 'グループ化したら箇所を見失った');
  assert.ok(report.entities > 0, 'グループ化したら置き換わる実体を見失った');
  assert.ok(restampAssembly(target, a.id) > 0, 'グループ化したら押し直せなくなった');
});

test('箇所の id を groupId に入れていた頃のファイルを、stampId に寄せて開く', async () => {
  const { scene, refs } = roomScene();
  const a = defineAssembly(scene, refs, '2LDK')!;
  const target = emptyScene();
  target.assemblies[a.id] = a;
  stampAssembly(target, a, vec(0, 0), 0, target.activeLevelId);

  const file = JSON.parse(JSON.stringify(serialize(target)));
  const stampId = Object.keys(target.stamps)[0];
  // 当時の書き方に戻す。箇所の id は groupId にあり、stampId は無い
  const walls = Object.values(file.scene.walls) as { attrs: Record<string, unknown> }[];
  // 1 本だけ**人が別の用途で使っていた値**にしておく。これは動かしてはいけない
  const stranger = walls[0];
  stranger.attrs.groupId = 'g-by-hand';
  delete stranger.attrs.stampId;
  let moved = 0;
  for (const w of walls) {
    if (w === stranger || w.attrs.stampId !== stampId) continue;
    w.attrs.groupId = w.attrs.stampId;
    delete w.attrs.stampId;
    moved += 1;
  }
  assert.ok(moved > 0, '箇所の付いた壁が無い');

  const back = deserialize({ ...file, version: 12 });
  const marked = Object.values(back.walls).filter((w) => w.attrs.stampId === stampId);
  assert.equal(marked.length, moved, '箇所の id が stampId に移っていない');
  assert.ok(marked.every((w) => w.attrs.groupId === null), '移したのに groupId が残っている');
  assert.equal(
    Object.values(back.walls).filter((w) => w.attrs.groupId === 'g-by-hand').length, 1,
    '人が別の用途で使っていた値まで動かした',
  );

  // いまの版のファイルは触らない
  const now = deserialize(JSON.parse(JSON.stringify(serialize(target))));
  assert.equal(
    Object.values(now.walls).filter((w) => w.attrs.stampId === stampId).length, moved + 1,
    '現行版のファイルの stampId を動かした',
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, type Scene } from '../src/core/types.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { vec } from '../src/core/geometry.ts';
import { DEFAULT_LEVEL_ID, levelsInOrder } from '../src/core/level.ts';
import {
  addLevel,
  countOnLevel,
  levelRemovalBlocker,
  removeLevel,
  renameLevel,
  setActiveLevel,
} from '../src/core/levelOps.ts';
import { makeOpening } from './make.ts';

/**
 * 階の増減。**UI から呼ぶ操作をここで押さえる。**
 *
 * いちばん危ないのは削除で、巻き添えにすると、どの階に何があったかを
 * 覚えていない人が 1 クリックで図面の半分を失う。
 */

test('上に足すと、床は下の階の壁の上に来る', () => {
  const scene = emptyScene();
  const base = scene.levels[DEFAULT_LEVEL_ID];
  base.wallHeight = 2500;

  const up = addLevel(scene, 'above');
  assert.equal(up.floorZ, base.floorZ + 2500, '2 階の床が 1 階の壁の上に来ていない');
  assert.equal(up.wallHeight, 2500, '階高が引き継がれていない');
  assert.equal(up.name, '2階');
});

test('下に足すと地下になる', () => {
  const scene = emptyScene();
  const down = addLevel(scene, 'below');
  assert.equal(down.name, 'B1');
  assert.equal(down.floorZ, -2400);
  assert.deepEqual(levelsInOrder(scene).map((l) => l.name), ['B1', '1階'], '並びが床高の順になっていない');

  // さらに下は B2
  assert.equal(addLevel(scene, 'below').name, 'B2');
});

test('足す先はいちばん上といちばん下で、作業中の階の隣ではない', () => {
  // **作業中の階の上に足すと、2 階と同じ高さの階ができる。**
  // どちらがどちらか分からなくなるので、いつも最上階の上に積む
  const scene = emptyScene();
  const second = addLevel(scene, 'above');
  scene.activeLevelId = DEFAULT_LEVEL_ID; // 1 階に戻ってから足す
  const third = addLevel(scene, 'above');
  assert.equal(third.floorZ, second.floorZ + second.wallHeight, '1 階の上に積んでしまっている');
  assert.equal(third.name, '3階');
});

test('名前が重なれば連番を足す', () => {
  // 名前は人が付け替えられるので、次の名前が既に使われていることがある。
  // ここでは地下を「2階」に改名して、最上階の上に足すときとぶつけている
  const scene = emptyScene();
  const down = addLevel(scene, 'below');
  assert.ok(renameLevel(scene, down.id, '2階'));

  const up = addLevel(scene, 'above');
  assert.equal(up.name, '2階 (2)', `ぶつかった名前: ${up.name}`);
  assert.equal(new Set(Object.values(scene.levels).map((l) => l.name)).size, 3, '名前が重なっている');
});

test('空名と重複の改名は断る', () => {
  const scene = emptyScene();
  const up = addLevel(scene, 'above');
  assert.ok(!renameLevel(scene, up.id, '   '), '空名が通った');
  assert.ok(!renameLevel(scene, up.id, '1階'), '重複が通った');
  assert.ok(renameLevel(scene, up.id, ' 中 2 階 '), 'まともな名前が通らない');
  assert.equal(scene.levels[up.id].name, '中 2 階', '前後の空白が残っている');
});

/** 1 階に壁 1 本と窓 1 つ、2 階は空 */
function sceneWithStuff(): { scene: Scene; upper: string } {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const wall = addWall(scene, a, b, 120)!;
  const op = makeOpening(wall.id, { kind: 'window', offset: 2000, width: 1600 });
  scene.openings[op.id] = op;
  const upper = addLevel(scene, 'above').id;
  return { scene, upper };
}

test('乗っているものを数える（建具は壁に訊くので一緒に数える）', () => {
  const { scene, upper } = sceneWithStuff();
  // 端点 2 つ・壁 1 本・建具 1 つ
  assert.equal(countOnLevel(scene, DEFAULT_LEVEL_ID), 4);
  assert.equal(countOnLevel(scene, upper), 0);
});

test('実体が乗っている階は消せない', () => {
  const { scene, upper } = sceneWithStuff();
  const blocker = levelRemovalBlocker(scene, DEFAULT_LEVEL_ID);
  assert.ok(blocker !== null, '中身のある階が消せてしまう');
  assert.match(blocker!, /4 個/, `個数が出ていない: ${blocker}`);
  assert.ok(!removeLevel(scene, DEFAULT_LEVEL_ID));
  assert.equal(Object.keys(scene.levels).length, 2, '断ったのに消えている');

  // 空の階は消せる
  assert.equal(levelRemovalBlocker(scene, upper), null);
  assert.ok(removeLevel(scene, upper));
  assert.equal(Object.keys(scene.levels).length, 1);
});

test('最後の階は消せない', () => {
  const scene = emptyScene();
  assert.match(levelRemovalBlocker(scene, DEFAULT_LEVEL_ID)!, /最後の階/);
  assert.ok(!removeLevel(scene, DEFAULT_LEVEL_ID));
});

test('作業中の階を消したら、いちばん下の階へ下りる', () => {
  const scene = emptyScene();
  const up = addLevel(scene, 'above');
  scene.activeLevelId = up.id;
  assert.ok(removeLevel(scene, up.id));
  assert.equal(scene.activeLevelId, DEFAULT_LEVEL_ID, '消えた階に居残っている');
});

test('知らない階には移らない', () => {
  const scene = emptyScene();
  assert.ok(!setActiveLevel(scene, 'もういない'));
  assert.equal(scene.activeLevelId, DEFAULT_LEVEL_ID);
  const up = addLevel(scene, 'above');
  assert.ok(setActiveLevel(scene, up.id));
  assert.equal(scene.activeLevelId, up.id);
});

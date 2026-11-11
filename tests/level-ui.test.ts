import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, type Scene } from '../src/core/types.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { vec } from '../src/core/geometry.ts';
import { isSelectable, isSnappable, levelIdOfRef, ENTITY_KINDS } from '../src/core/entity.ts';
import { pickAt } from '../src/core/pick.ts';
import { snapPoint } from '../src/core/snap.ts';
import { defaultSettings } from '../src/core/store.ts';
import { DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { buildMesh, type Face3 } from '../src/render3d/mesh.ts';
import { detectRooms } from '../src/core/rooms.ts';

/**
 * 階ごとの 2D。**同じ座標に 1 階と 2 階の壁を置いて**、作業中の階の
 * ものだけが掴める・スナップすることを見る。
 *
 * 2D は 1 枚の紙なので、階を分けないと両方が同じ場所に重なり、
 * 見えていないものを掴む。原因の分かりにくい壊れ方なので、
 * 関所（`isSelectable` / `isSnappable`）で止める。
 */

/** 1 階と 2 階に、**同じ座標の**壁を 1 本ずつ */
function twoFloors(): { scene: Scene; lower: string; upper: string } {
  const scene = emptyScene();
  scene.levels['lv-2'] = { id: 'lv-2', name: '2階', floorZ: 3000, wallHeight: 2400 };

  scene.activeLevelId = DEFAULT_LEVEL_ID;
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const lower = addWall(scene, a, b, 120)!.id;

  scene.activeLevelId = 'lv-2';
  const c = findOrCreateNode(scene, vec(0, 0));
  const d = findOrCreateNode(scene, vec(4000, 0));
  const upper = addWall(scene, c, d, 120)!.id;

  return { scene, lower, upper };
}

test('階を跨いでノードが溶けない（前提）', () => {
  const { scene, lower, upper } = twoFloors();
  assert.notEqual(lower, upper, '同じ壁になってしまっている');
  assert.equal(Object.keys(scene.nodes).length, 4, '1 階と 2 階の端点が溶けている');
});

test('実体はどの階かを答える', () => {
  const { scene, lower, upper } = twoFloors();
  assert.equal(levelIdOfRef(scene, { type: 'wall', id: lower }), DEFAULT_LEVEL_ID);
  assert.equal(levelIdOfRef(scene, { type: 'wall', id: upper }), 'lv-2');
});

test('どの種別も階を答えられる（足し忘れたら落ちる）', () => {
  const scene = emptyScene();
  for (const [type, kind] of Object.entries(ENTITY_KINDS)) {
    assert.equal(
      typeof kind.levelIdOf, 'function',
      `${type} に levelIdOf が無い`,
    );
    // 知らない id でも落ちない
    assert.equal(kind.levelIdOf(scene, 'もういない'), null, `${type}`);
  }
});

test('他の階のものは選べない', () => {
  const { scene, lower, upper } = twoFloors();
  scene.activeLevelId = DEFAULT_LEVEL_ID;
  assert.ok(isSelectable(scene, { type: 'wall', id: lower }), '1 階で 1 階の壁が選べない');
  assert.ok(!isSelectable(scene, { type: 'wall', id: upper }), '1 階で 2 階の壁が選べてしまう');

  scene.activeLevelId = 'lv-2';
  assert.ok(!isSelectable(scene, { type: 'wall', id: lower }), '2 階で 1 階の壁が選べてしまう');
  assert.ok(isSelectable(scene, { type: 'wall', id: upper }), '2 階で 2 階の壁が選べない');
});

test('他の階のものにはスナップしない', () => {
  const { scene, lower, upper } = twoFloors();
  scene.activeLevelId = DEFAULT_LEVEL_ID;
  assert.ok(isSnappable(scene, { type: 'wall', id: lower }));
  assert.ok(!isSnappable(scene, { type: 'wall', id: upper }), '1 階で 2 階の壁にスナップする');
});

test('クリックしても他の階は拾わない', () => {
  const { scene, lower, upper } = twoFloors();
  // 壁の真ん中。1 階・2 階どちらの壁もここを通る
  const at = vec(2000, 0);

  scene.activeLevelId = DEFAULT_LEVEL_ID;
  const hit1 = pickAt(scene, at, 50);
  assert.deepEqual(hit1, { type: 'wall', id: lower }, `1 階で拾ったもの: ${JSON.stringify(hit1)}`);

  scene.activeLevelId = 'lv-2';
  const hit2 = pickAt(scene, at, 50);
  assert.deepEqual(hit2, { type: 'wall', id: upper }, `2 階で拾ったもの: ${JSON.stringify(hit2)}`);
});

test('スナップも作業中の階の端点だけを見る', () => {
  // **同じ座標に置くと識別しない。** どちらに吸い付いても座標が同じなので、
  // 階を見ていなくても通ってしまう。1 階にだけ端点がある場所で測る。
  const scene = emptyScene();
  scene.levels['lv-2'] = { id: 'lv-2', name: '2階', floorZ: 3000, wallHeight: 2400 };

  scene.activeLevelId = DEFAULT_LEVEL_ID;
  addWall(scene, findOrCreateNode(scene, vec(0, 0)), findOrCreateNode(scene, vec(4000, 0)), 120);

  scene.activeLevelId = 'lv-2';
  addWall(scene, findOrCreateNode(scene, vec(0, 9000)), findOrCreateNode(scene, vec(4000, 9000)), 120);

  // 1 階の端点のすぐそば。2 階には何も無い
  const near1F = vec(4010, 5);

  // 格子スナップは切る。**格子が拾ってしまうと階の違いが見えない**
  const st = { ...defaultSettings(), snapGrid: false, snapWall: false };

  scene.activeLevelId = DEFAULT_LEVEL_ID;
  const onFirst = snapPoint(scene, st, near1F, { radius: 100 });
  assert.equal(onFirst?.kind, 'node', '1 階にいるのに 1 階の端点へ吸い付かない');

  scene.activeLevelId = 'lv-2';
  const onSecond = snapPoint(scene, st, near1F, { radius: 100 });
  // 吸い付かなかったときは `free` が返る（null ではない）
  assert.notEqual(
    onSecond?.kind, 'node',
    `2 階にいるのに 1 階の端点へ吸い付いた: ${JSON.stringify(onSecond)}`,
  );
});

test('3D は作業中の階だけでなく、全部の階を積む', () => {
  // **2D と 3D で問いが違う。** 2D は 1 枚の紙なので作業中の階だけ、
  // 3D は `floorZ` で重ねて全部を見せる。
  // 階の関所を `isSnappable` に畳んだとき、`mesh.ts` がそれを
  // 「3D に出すか」の判定にも使っていたため 3D が 1 階だけになった。
  const { scene } = twoFloors();
  const meshOf = (sc: Scene) => buildMesh(sc, detectRooms(sc));
  for (const active of ['lv-1', 'lv-2']) {
    scene.activeLevelId = active;
    const levels = [...new Set(meshOf(scene).map((f: Face3) => f.levelId))].sort();
    assert.deepEqual(levels, ['lv-1', 'lv-2'], `${active} にいるとき 3D が全階を積んでいない`);
  }
});

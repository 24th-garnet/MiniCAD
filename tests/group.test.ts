import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, type EntityRef } from '../src/core/types.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { vec } from '../src/core/geometry.ts';
import { expandGroups, groupEntities, groupSize, ungroupEntities } from '../src/core/group.ts';
import { attrsOf } from '../src/core/material.ts';
import { Store } from '../src/core/store.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { makeOpening } from './make.ts';

/** 4 辺の矩形と、そのうち 1 本に付いた建具 */
function boxScene() {
  const scene = emptyScene();
  const ids = [
    findOrCreateNode(scene, vec(0, 0)),
    findOrCreateNode(scene, vec(4000, 0)),
    findOrCreateNode(scene, vec(4000, 3000)),
    findOrCreateNode(scene, vec(0, 3000)),
  ];
  const wallIds: string[] = [];
  for (let i = 0; i < 4; i++) wallIds.push(addWall(scene, ids[i], ids[(i + 1) % 4], 100)!.id);
  const op = makeOpening(wallIds[0], { kind: 'door', offset: 2000, width: 800 });
  scene.openings[op.id] = op;
  return { scene, wallIds, openingId: op.id };
}

const wallRefs = (ids: string[]): EntityRef[] => ids.map((id) => ({ type: 'wall', id }));

test('グループにすると、1 つ掴んで全部が広がる', () => {
  const { scene, wallIds } = boxScene();
  const id = groupEntities(scene, wallRefs(wallIds.slice(0, 3)));
  assert.ok(id, 'グループができていない');

  const expanded = expandGroups(scene, [{ type: 'wall', id: wallIds[0] }]);
  assert.equal(expanded.length, 3, `広がった数が違う (${expanded.length})`);
  assert.ok(expanded.every((r) => r.type === 'wall' && wallIds.slice(0, 3).includes(r.id)));

  // グループに入っていない 4 本目は、掴んでも 1 つのまま
  assert.equal(expandGroups(scene, [{ type: 'wall', id: wallIds[3] }]).length, 1);
});

test('1 つしか選んでいなければグループにならない', () => {
  const { scene, wallIds } = boxScene();
  assert.equal(groupEntities(scene, wallRefs(wallIds.slice(0, 1))), null);
  assert.equal(groupEntities(scene, []), null);
});

test('属性を持たない種別はグループに入らない', () => {
  const { scene, wallIds } = boxScene();
  const nodeId = Object.keys(scene.nodes)[0];
  const id = groupEntities(scene, [
    { type: 'wall', id: wallIds[0] },
    { type: 'node', id: nodeId },
    { type: 'wall', id: wallIds[1] },
  ]);
  assert.ok(id);
  assert.equal(groupSize(scene, { type: 'wall', id: wallIds[0] }), 2, 'ノードが数に入っている');
});

test('グループ済みのものを含めてまとめると、元のグループごと 1 つになる', () => {
  const { scene, wallIds, openingId } = boxScene();
  groupEntities(scene, wallRefs(wallIds.slice(0, 2)));
  // 1 本目（グループ済み）と、3 本目・建具をまとめる
  groupEntities(scene, [
    { type: 'wall', id: wallIds[0] },
    { type: 'wall', id: wallIds[2] },
    { type: 'opening', id: openingId },
  ]);
  // **元のグループが欠けない。** 2 本目も巻き込まれて 1 つの大きいグループになる
  assert.equal(groupSize(scene, { type: 'wall', id: wallIds[1] }), 4);
  assert.equal(
    attrsOf(scene, { type: 'wall', id: wallIds[1] })!.groupId,
    attrsOf(scene, { type: 'opening', id: openingId })!.groupId,
  );
});

test('一部だけ選んで解除しても、グループ全体が解ける', () => {
  const { scene, wallIds } = boxScene();
  groupEntities(scene, wallRefs(wallIds));
  assert.ok(ungroupEntities(scene, [{ type: 'wall', id: wallIds[0] }]));
  for (const id of wallIds) {
    assert.equal(attrsOf(scene, { type: 'wall', id })!.groupId, null, `${id} が解けていない`);
  }
  assert.equal(ungroupEntities(scene, [{ type: 'wall', id: wallIds[0] }]), false, '解くものが無いのに true');
});

test('選択はグループごと入り、グループごと外れる', () => {
  const { scene, wallIds } = boxScene();
  groupEntities(scene, wallRefs(wallIds.slice(0, 3)));
  const store = new Store();
  store.replaceScene(scene, { keepHistory: false });

  store.setSelection([{ type: 'wall', id: wallIds[0] }]);
  assert.equal(store.selection.length, 3, '1 つ選んでグループが広がらない');

  // Shift クリックで仲間ごと外れる
  store.toggleSelection({ type: 'wall', id: wallIds[1] });
  assert.equal(store.selection.length, 0, 'グループの一部だけが外れた');

  // Shift クリックで仲間ごと入る
  store.setSelection([{ type: 'wall', id: wallIds[3] }]);
  store.toggleSelection({ type: 'wall', id: wallIds[0] });
  assert.equal(store.selection.length, 4, 'グループが仲間ごと入らない');
});

test('グループは保存と読み込みを往復する', () => {
  const { scene, wallIds, openingId } = boxScene();
  const id = groupEntities(scene, [
    { type: 'wall', id: wallIds[0] },
    { type: 'opening', id: openingId },
  ]);
  const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
  assert.equal(back.walls[wallIds[0]].attrs.groupId, id);
  assert.equal(back.openings[openingId].attrs.groupId, id);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEyedrop, pickEyedrop } from '../src/core/eyedrop.ts';
import { groupEntities } from '../src/core/group.ts';
import { defaultAttrs, type Attrs } from '../src/core/attrs.ts';
import { attrsOf } from '../src/core/material.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { vec } from '../src/core/geometry.ts';
import { emptyScene, newId, type EntityRef, type Scene } from '../src/core/types.ts';

/**
 * スポイト（7 段）。**運ぶものと運ばないものの線引きが全部。**
 *
 * `groupId` を配ると人の作ったグループに勝手に加わり、`stampId` /
 * `symbolId` / `symbolVersion` を配ると**シンボルの一括変更が押し直す相手を壊す**。
 */

function shape(scene: Scene, id: string, layerId: string, attrs: Partial<Attrs> = {}): EntityRef {
  scene.shapes[id] = {
    id, shape: 'line', a: vec(0, 0), b: vec(1000, 0),
    layerId, attrs: { ...defaultAttrs(), ...attrs },
  } as never;
  return { type: 'shape', id };
}

test('色・素材・積算・画層を運ぶ', () => {
  const scene = emptyScene();
  const from = shape(scene, 'a', LAYER_IDS.dimension, {
    color: '#ff0000', materialRef: 'mat-1', takeoff: 'excluded',
  });
  const to = shape(scene, 'b', LAYER_IDS.shape);

  const held = pickEyedrop(scene, from)!;
  assert.ok(applyEyedrop(scene, [to], held));
  const got = attrsOf(scene, to)!;
  assert.equal(got.color, '#ff0000');
  assert.equal(got.materialRef, 'mat-1');
  assert.equal(got.takeoff, 'excluded');
  assert.equal(scene.shapes.b.layerId, LAYER_IDS.dimension, '画層が運ばれていない');
});

test('グループとシンボルは運ばない', () => {
  const scene = emptyScene();
  const a = shape(scene, 'a', LAYER_IDS.shape);
  const b = shape(scene, 'b', LAYER_IDS.shape);
  groupEntities(scene, [a, b]);
  scene.shapes.a.attrs.stampId = newId('st');
  scene.shapes.a.attrs.symbolId = newId('sy');
  scene.shapes.a.attrs.symbolVersion = 3;

  const target = shape(scene, 'c', LAYER_IDS.shape);
  applyEyedrop(scene, [target], pickEyedrop(scene, a)!);

  const got = attrsOf(scene, target)!;
  assert.equal(got.groupId, null, 'グループに勝手に加わった');
  assert.equal(got.stampId, null, 'スタンプが運ばれた');
  assert.equal(got.symbolId, null, 'シンボルが運ばれた');
  assert.equal(got.symbolVersion, null, 'シンボルの版が運ばれた');
  // 元のグループは壊れていない
  assert.equal(attrsOf(scene, a)!.groupId, attrsOf(scene, b)!.groupId);
  assert.ok(attrsOf(scene, a)!.groupId);
});

test('色を指していないものを吸うと、配った先も画層の色に戻る', () => {
  // **「指定なし」も 1 つの状態。** 吸った先の色を消せないと、戻す手段が無くなる
  const scene = emptyScene();
  const plain = shape(scene, 'a', LAYER_IDS.shape);
  const red = shape(scene, 'b', LAYER_IDS.shape, { color: '#ff0000' });
  applyEyedrop(scene, [red], pickEyedrop(scene, plain)!);
  assert.equal(attrsOf(scene, red)!.color, null);
});

test('属性を持たないものからは吸えない', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  addWall(scene, a, findOrCreateNode(scene, vec(4000, 0)), 120);
  assert.equal(pickEyedrop(scene, { type: 'node', id: a }), null, 'ノードから吸えてしまう');
});

test('壁からも吸え、壁にも配れる', () => {
  const scene = emptyScene();
  const wall = addWall(scene, findOrCreateNode(scene, vec(0, 0)), findOrCreateNode(scene, vec(4000, 0)), 120)!;
  const ref: EntityRef = { type: 'wall', id: wall.id };
  const from = shape(scene, 'a', LAYER_IDS.shape, { color: '#00ff00' });
  assert.ok(applyEyedrop(scene, [ref], pickEyedrop(scene, from)!));
  assert.equal(wall.attrs.color, '#00ff00');
  assert.equal(wall.layerId, LAYER_IDS.shape);
});

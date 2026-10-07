import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleScene } from '../src/io/sample.ts';
import { pickAt, pickInRect } from '../src/core/pick.ts';
import { snapPoint } from '../src/core/snap.ts';
import { defaultSettings } from '../src/core/store.ts';
import { isSelectable, isSnappable, removeEntities, sceneBounds, ENTITY_KINDS } from '../src/core/entity.ts';
import { resolveSelection, captureOrigins, placeSelection, selectionCenter } from '../src/core/selection.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { vec } from '../src/core/geometry.ts';
import { openingsOnWall } from '../src/core/ops.ts';
import type { EntityRef } from '../src/core/types.ts';

/** サンプルの南側外壁（y=0 付近）のうち、窓が開いていないところ */
const ON_WALL = vec(500, 0);

test('画層をロックすると選択できなくなるが、スナップは効く', () => {
  const scene = sampleScene();
  assert.equal(pickAt(scene, ON_WALL, 80)?.type, 'wall', '前提: 通常は壁が拾える');

  scene.layers[LAYER_IDS.wall].locked = true;
  assert.equal(pickAt(scene, ON_WALL, 80), null, 'ロック中の壁が拾えてしまう');

  // ロックした画層にもスナップできるのが CAD の作法
  const snap = snapPoint(scene, defaultSettings(), vec(60, 60), { radius: 300 });
  assert.equal(snap.kind, 'node', `端点にスナップするはず: ${snap.kind}`);
});

test('画層を非表示にすると選択もスナップもできなくなる', () => {
  const scene = sampleScene();
  scene.layers[LAYER_IDS.wall].visible = false;

  assert.equal(pickAt(scene, ON_WALL, 80), null);
  const snap = snapPoint(scene, defaultSettings(), vec(60, 60), { radius: 300 });
  assert.notEqual(snap.kind, 'node', '非表示の壁の端点にスナップしている');
});

test('respectLayers: false なら画層を無視して拾える', () => {
  const scene = sampleScene();
  scene.layers[LAYER_IDS.wall].locked = true;
  assert.equal(pickAt(scene, ON_WALL, 80, { respectLayers: false })?.type, 'wall');
});

test('接続する壁がすべて非表示のノードは拾えない', () => {
  const scene = sampleScene();
  const corner = vec(0, 0);
  assert.equal(pickAt(scene, corner, 80)?.type, 'node', '前提: 通常は端点が拾える');

  scene.layers[LAYER_IDS.wall].visible = false;
  const hit = pickAt(scene, corner, 80);
  assert.ok(hit === null || hit.type !== 'node', '非表示の壁の端点が拾えてしまう');
});

test('矩形選択も画層のロックに従う', () => {
  const scene = sampleScene();
  const all = pickInRect(scene, vec(-500, -500), vec(9000, 7000), false);
  assert.ok(all.some((r) => r.type === 'wall'));

  scene.layers[LAYER_IDS.wall].locked = true;
  const locked = pickInRect(scene, vec(-500, -500), vec(9000, 7000), false);
  assert.ok(!locked.some((r) => r.type === 'wall'), 'ロック中の壁が矩形選択で拾えてしまう');
  assert.ok(locked.some((r) => r.type === 'furniture'), '他の画層は拾えるべき');
});

test('isSelectable と isSnappable の違い', () => {
  const scene = sampleScene();
  const wallId = Object.keys(scene.walls)[0];
  const ref: EntityRef = { type: 'wall', id: wallId };

  scene.layers[LAYER_IDS.wall].locked = true;
  assert.equal(isSelectable(scene, ref), false);
  assert.equal(isSnappable(scene, ref), true, 'ロックでもスナップは効く');

  scene.layers[LAYER_IDS.wall].visible = false;
  assert.equal(isSnappable(scene, ref), false);
});

test('壁を消すとその開口部も消える', () => {
  const scene = sampleScene();
  // 開口部が付いている壁を選ぶ
  const wallId = Object.values(scene.openings)[0].wallId;
  const before = openingsOnWall(scene, wallId).length;
  assert.ok(before > 0);

  assert.equal(removeEntities(scene, [{ type: 'wall', id: wallId }]), true);
  assert.equal(scene.walls[wallId], undefined);
  assert.equal(openingsOnWall(scene, wallId).length, 0);
});

test('存在しないものを消しても変更なしと報告する', () => {
  const scene = sampleScene();
  assert.equal(removeEntities(scene, [{ type: 'wall', id: 'nope' }]), false);
});

test('ノードを消すと取り付く壁も消える', () => {
  const scene = sampleScene();
  const nodeId = Object.keys(scene.nodes)[0];
  const wallsBefore = Object.keys(scene.walls).length;
  removeEntities(scene, [{ type: 'node', id: nodeId }]);
  assert.ok(Object.keys(scene.walls).length < wallsBefore);
  assert.equal(scene.nodes[nodeId], undefined);
});

test('図面範囲が全エンティティを含む', () => {
  const scene = sampleScene();
  const b = sceneBounds(scene)!;
  assert.ok(b);
  // サンプルは外周 0..8000 x 0..6000。家具が外に出ていないこと
  assert.ok(b.min.x >= -1 && b.min.y >= -1, `min=${JSON.stringify(b.min)}`);
  assert.ok(b.max.x <= 8001 && b.max.y <= 6001, `max=${JSON.stringify(b.max)}`);
  // 家具の隅が含まれている（ノードだけでは出ない精度）
  assert.ok(b.max.x > 7000);
});

test('空のシーンの図面範囲は null', () => {
  const scene = sampleScene();
  for (const type of ['wall', 'opening', 'furniture', 'roomLabel', 'node'] as const) {
    for (const id of Object.keys(ENTITY_KINDS[type].table(scene))) {
      ENTITY_KINDS[type].remove(scene, id);
    }
  }
  assert.equal(sceneBounds(scene), null);
});

test('壁を選ぶと両端のノードが動く対象になる', () => {
  const scene = sampleScene();
  const wall = Object.values(scene.walls)[0];
  const sel = resolveSelection(scene, [{ type: 'wall', id: wall.id }]);
  assert.deepEqual(sel.nodeIds.sort(), [wall.a, wall.b].sort());
});

test('同じノードを共有する2つの壁を選んでもノードは1つだけ動く', () => {
  const scene = sampleScene();
  const walls = Object.values(scene.walls);
  const a = walls[0];
  const b = walls.find((w) => w.id !== a.id && (w.a === a.b || w.b === a.b || w.a === a.a || w.b === a.a))!;
  const sel = resolveSelection(scene, [
    { type: 'wall', id: a.id },
    { type: 'wall', id: b.id },
  ]);
  assert.equal(new Set(sel.nodeIds).size, sel.nodeIds.length, 'ノードが重複している');
});

test('同じ変位を何度適用しても累積しない', () => {
  const scene = sampleScene();
  const wall = Object.values(scene.walls)[0];
  const sel = resolveSelection(scene, [{ type: 'wall', id: wall.id }]);
  const origins = captureOrigins(scene, sel);
  const start = { ...scene.nodes[wall.a] };

  placeSelection(scene, origins, vec(100, 200));
  placeSelection(scene, origins, vec(100, 200));
  placeSelection(scene, origins, vec(100, 200));

  assert.equal(scene.nodes[wall.a].x, start.x + 100);
  assert.equal(scene.nodes[wall.a].y, start.y + 200);
});

test('選択の中心が家具の位置と一致する', () => {
  const scene = sampleScene();
  const f = Object.values(scene.furniture)[0];
  const center = selectionCenter(scene, resolveSelection(scene, [{ type: 'furniture', id: f.id }]))!;
  assert.ok(Math.abs(center.x - f.x) < 1e-9 && Math.abs(center.y - f.y) < 1e-9);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleScene } from '../src/io/sample.ts';
import { emptyScene, type Scene } from '../src/core/types.ts';
import { addWall, findOrCreateNode, nodePos } from '../src/core/ops.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { doorSwing, openingFrame } from '../src/core/shape.ts';
import { transformEntities, isNoopTransform } from '../src/core/transformOps.ts';
import { applyPoint, mirror, rotation, translation } from '../src/core/transform.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { dist, toRad, vec, type Vec } from '../src/core/geometry.ts';
import { Store } from '../src/core/store.ts';
import type { EntityRef } from '../src/core/types.ts';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const nearPt = (a: Vec, b: Vec, eps = 1e-6) => near(a.x, b.x, eps) && near(a.y, b.y, eps);

/** 4辺の矩形を1つ持つシーン */
function boxScene(): { scene: Scene; wallIds: string[] } {
  const scene = emptyScene();
  const ids = [
    findOrCreateNode(scene, vec(0, 0)),
    findOrCreateNode(scene, vec(4000, 0)),
    findOrCreateNode(scene, vec(4000, 3000)),
    findOrCreateNode(scene, vec(0, 3000)),
  ];
  const wallIds: string[] = [];
  for (let i = 0; i < 4; i++) wallIds.push(addWall(scene, ids[i], ids[(i + 1) % 4], 100)!.id);
  return { scene, wallIds };
}

const wallRefs = (ids: string[]): EntityRef[] => ids.map((id) => ({ type: 'wall', id }));

test('複写した壁は新しいノードを持ち、元と共有しない', () => {
  const { scene, wallIds } = boxScene();
  const before = Object.keys(scene.nodes).length;

  const result = transformEntities(scene, wallRefs(wallIds), translation(vec(10000, 0)), { copy: true });

  assert.equal(Object.keys(scene.nodes).length, before * 2, 'ノードが複製されていない');
  assert.equal(Object.keys(scene.walls).length, 8);
  assert.equal(result.refs.length, 4);

  const originalNodeIds = new Set([...result.nodeMap.keys()]);
  for (const ref of result.refs) {
    const wall = scene.walls[ref.id];
    assert.ok(!originalNodeIds.has(wall.a) && !originalNodeIds.has(wall.b), '元のノードを参照している');
  }
});

test('複写したあと元のノードを動かしてもコピーは動かない', () => {
  const { scene, wallIds } = boxScene();
  const result = transformEntities(scene, wallRefs(wallIds), translation(vec(10000, 0)), { copy: true });
  const copiedWall = scene.walls[result.refs[0].id];
  const copiedBefore = nodePos(scene, copiedWall.a);

  const originalNodeId = [...result.nodeMap.keys()][0];
  scene.nodes[originalNodeId].x += 5000;

  assert.ok(nearPt(nodePos(scene, copiedWall.a), copiedBefore), 'コピーが元に引きずられている');
});

test('閉じた矩形を複写すると部屋が1つ増える', () => {
  const { scene, wallIds } = boxScene();
  assert.equal(detectRooms(scene).length, 1);
  transformEntities(scene, wallRefs(wallIds), translation(vec(10000, 0)), { copy: true });
  assert.equal(detectRooms(scene).length, 2);
});

test('変位ゼロの複写は弾かれる', () => {
  assert.equal(isNoopTransform(translation(vec(0, 0)), vec(100, 100)), true);
  assert.equal(isNoopTransform(translation(vec(1, 0)), vec(100, 100)), false);
  assert.equal(isNoopTransform(rotation(vec(0, 0), toRad(90)), vec(100, 100)), false);
  // 鏡像は軸上の点では動かないが、変換としては意味がある
  assert.equal(isNoopTransform(mirror(vec(0, 0), vec(1, 0)), vec(500, 0)), false);
});

test('90度回転を4回で元に戻る', () => {
  const { scene, wallIds } = boxScene();
  const before = Object.values(scene.nodes).map((n) => vec(n.x, n.y));
  const refs = wallRefs(wallIds);
  for (let i = 0; i < 4; i++) {
    transformEntities(scene, refs, rotation(vec(2000, 1500), Math.PI / 2), { copy: false });
  }
  const after = Object.values(scene.nodes).map((n) => vec(n.x, n.y));
  for (let i = 0; i < before.length; i++) {
    assert.ok(nearPt(before[i], after[i], 1e-6), `${i}: ${JSON.stringify(after[i])}`);
  }
});

test('鏡像を2回かけると元に戻る', () => {
  const { scene, wallIds } = boxScene();
  const before = Object.values(scene.nodes).map((n) => vec(n.x, n.y));
  const refs = wallRefs(wallIds);
  const t = mirror(vec(0, 0), vec(1, 2));
  transformEntities(scene, refs, t, { copy: false });
  transformEntities(scene, refs, t, { copy: false });
  const after = Object.values(scene.nodes).map((n) => vec(n.x, n.y));
  for (let i = 0; i < before.length; i++) assert.ok(nearPt(before[i], after[i], 1e-6));
});

test('家具は座標と向きが追従し、寸法は変わらない', () => {
  const scene = sampleScene();
  const f = Object.values(scene.furniture).find((x) => x.name === 'ソファ')!;
  const original = { x: f.x, y: f.y, w: f.w, h: f.h, angle: f.angle };

  transformEntities(scene, [{ type: 'furniture', id: f.id }], rotation(vec(0, 0), toRad(90)), { copy: false });

  assert.ok(nearPt(vec(f.x, f.y), applyPoint(rotation(vec(0, 0), toRad(90)), vec(original.x, original.y))));
  assert.ok(near(f.angle, original.angle + toRad(90), 1e-9));
  assert.equal(f.w, original.w);
  assert.equal(f.h, original.h);
});

test('鏡像したドアの開き勝手が見た目どおり反転する', () => {
  const scene = sampleScene();
  const op = Object.values(scene.openings).find((o) => o.kind === 'door')!;
  const wall = scene.walls[op.wallId];
  const t = mirror(vec(0, 0), vec(0, 1)); // y 軸での鏡像

  const beforeFrame = openingFrame(scene, op)!;
  const beforeSwing = doorSwing(beforeFrame, op.flipX, op.flipY);
  const expected = {
    hinge: applyPoint(t, beforeSwing.hinge),
    open: applyPoint(t, beforeSwing.open),
    closed: applyPoint(t, beforeSwing.closed),
  };

  transformEntities(scene, [{ type: 'wall', id: wall.id }], t, { copy: false });

  const afterFrame = openingFrame(scene, op)!;
  const afterSwing = doorSwing(afterFrame, op.flipX, op.flipY);

  assert.ok(nearPt(afterSwing.hinge, expected.hinge, 1e-6), `吊元: ${JSON.stringify(afterSwing.hinge)}`);
  assert.ok(nearPt(afterSwing.open, expected.open, 1e-6), `開いた先: ${JSON.stringify(afterSwing.open)}`);
  assert.ok(nearPt(afterSwing.closed, expected.closed, 1e-6), `閉じた先: ${JSON.stringify(afterSwing.closed)}`);
});

test('開口の付いた壁を複写すると開口も複製される', () => {
  const scene = sampleScene();
  const op = Object.values(scene.openings)[0];
  const before = Object.keys(scene.openings).length;

  transformEntities(scene, [{ type: 'wall', id: op.wallId }], translation(vec(0, 20000)), { copy: true });

  const after = Object.values(scene.openings);
  assert.equal(after.length, before + 1);
  const copied = after.find((o) => o.id !== op.id && o.width === op.width && o.offset === op.offset)!;
  assert.ok(copied, '複製された開口が見つからない');
  assert.notEqual(copied.wallId, op.wallId);
  assert.equal(copied.flipX, op.flipX);
  assert.equal(copied.flipY, op.flipY, '平行移動では開き勝手は変わらない');
});

test('片端しか選ばれていない壁は複製されない', () => {
  const { scene, wallIds } = boxScene();
  const wall = scene.walls[wallIds[0]];
  const before = Object.keys(scene.walls).length;
  transformEntities(scene, [{ type: 'node', id: wall.a }], translation(vec(1000, 0)), { copy: true });
  assert.equal(Object.keys(scene.walls).length, before, '行き場のない壁が作られている');
});

test('円弧を鏡像すると向きが入れ替わり、掃く範囲が保たれる', () => {
  const scene = emptyScene();
  scene.shapes['a1'] = {
    id: 'a1',
    shape: 'arc',
    layerId: LAYER_IDS.shape,
    center: vec(1000, 0),
    radius: 500,
    startAngle: 0,
    endAngle: Math.PI / 2,
  };
  const sweepOf = (s: typeof scene.shapes.a1) => {
    if (s.shape !== 'arc') return 0;
    let v = s.endAngle - s.startAngle;
    while (v < 0) v += Math.PI * 2;
    return v;
  };
  const before = sweepOf(scene.shapes['a1']);

  transformEntities(scene, [{ type: 'shape', id: 'a1' }], mirror(vec(0, 0), vec(0, 1)), { copy: false });

  const after = scene.shapes['a1'];
  assert.equal(after.shape, 'arc');
  assert.ok(near(sweepOf(after), before, 1e-9), `掃き角が変わった: ${sweepOf(after)} vs ${before}`);
  if (after.shape === 'arc') {
    assert.ok(nearPt(after.center, vec(-1000, 0)), '中心が鏡像になっていない');
  }
});

test('文字は位置と向きが変わるが、内容は変わらない', () => {
  const scene = emptyScene();
  scene.shapes['t1'] = {
    id: 't1',
    shape: 'text',
    layerId: LAYER_IDS.roomName,
    at: vec(100, 200),
    text: '注記',
    height: 3.5,
    angle: 0,
    align: 'center',
  };
  transformEntities(scene, [{ type: 'shape', id: 't1' }], rotation(vec(0, 0), toRad(90)), { copy: false });
  const after = scene.shapes['t1'];
  assert.equal(after.shape, 'text');
  if (after.shape === 'text') {
    assert.equal(after.text, '注記');
    assert.ok(nearPt(after.at, vec(-200, 100)));
    assert.ok(near(after.angle, toRad(90), 1e-9));
  }
});

test('複写を undo すると1回で元に戻る', () => {
  const store = new Store();
  const { scene, wallIds } = boxScene();
  store.replaceScene(scene, { keepHistory: false });
  const before = Object.keys(store.scene.walls).length;

  store.commit(() => {
    transformEntities(store.scene, wallRefs(wallIds), translation(vec(10000, 0)), { copy: true });
  });
  assert.equal(Object.keys(store.scene.walls).length, before * 2);

  store.undo();
  assert.equal(Object.keys(store.scene.walls).length, before);
});

test('画層とプロパティが複製で引き継がれる', () => {
  const { scene, wallIds } = boxScene();
  scene.walls[wallIds[0]].layerId = LAYER_IDS.axis;
  scene.walls[wallIds[0]].thickness = 250;

  const result = transformEntities(scene, wallRefs(wallIds), translation(vec(10000, 0)), { copy: true });
  const copied = result.refs.map((r) => scene.walls[r.id]);
  assert.ok(copied.some((w) => w.layerId === LAYER_IDS.axis && w.thickness === 250));
});

test('複写した矩形の形が保たれる', () => {
  const { scene, wallIds } = boxScene();
  const result = transformEntities(scene, wallRefs(wallIds), rotation(vec(0, 0), toRad(37)), { copy: true });
  for (const ref of result.refs) {
    const wall = scene.walls[ref.id];
    const length = dist(nodePos(scene, wall.a), nodePos(scene, wall.b));
    assert.ok(near(length, 4000, 1e-6) || near(length, 3000, 1e-6), `辺の長さが変わった: ${length}`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BAY_SHAPES, bayOutline, defaultBay, hasBay, type Bay } from '../src/core/bay.ts';
import { openingFrame } from '../src/core/shape.ts';
import { findOrCreateNode, addWall } from '../src/core/ops.ts';
import { emptyScene, newId, type Opening, type Scene } from '../src/core/types.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { vec } from '../src/core/geometry.ts';
import { deserialize, serialize } from '../src/io/scene.ts';
import { buildMesh } from '../src/render3d/mesh.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { LAYER_IDS } from '../src/core/layer.ts';

function sceneWithWindow(bay: Bay | null): { scene: Scene; opening: Opening } {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(4000, 0));
  const wall = addWall(scene, a, b, 120)!;
  const id = newId('o');
  const opening: Opening = {
    id, wallId: wall.id, offset: 2000, width: 1600, kind: 'window',
    flipX: false, flipY: false, sillHeight: null, height: null, bay,
    designation: '', leaves: 2,
    layerId: LAYER_IDS.opening, attrs: defaultAttrs(),
  };
  scene.openings[id] = opening;
  return { scene, opening };
}

test('張り出しは壁の面から出る（壁芯からではない）', () => {
  // 壁芯から測ると、出 450 の出窓が壁厚の半分だけ短く見える
  const { scene, opening } = sceneWithWindow({ shape: 'box', depth: 450, side: 1 });
  const frame = openingFrame(scene, opening)!;
  const poly = bayOutline(frame, opening.bay!);
  const offsets = poly.map((p) => p.y);
  assert.ok(Math.abs(Math.min(...offsets) - 60) < 1e-6, `壁の面から始まっていない (${Math.min(...offsets)})`);
  assert.ok(Math.abs(Math.max(...offsets) - 510) < 1e-6, `出が 450 になっていない (${Math.max(...offsets)})`);
});

test('ニッチは出が負で、内側へ凹む', () => {
  const { scene, opening } = sceneWithWindow({ shape: 'box', depth: -150, side: 1 });
  const frame = openingFrame(scene, opening)!;
  const offsets = bayOutline(frame, opening.bay!).map((p) => p.y);
  assert.ok(Math.max(...offsets) <= 60 + 1e-6, '外へ張り出している');
  assert.ok(Math.abs(Math.min(...offsets) - (-90)) < 1e-6, `凹みが 150 になっていない (${Math.min(...offsets)})`);
});

test('反対側へ出せる', () => {
  const { scene, opening } = sceneWithWindow({ shape: 'box', depth: 450, side: -1 });
  const frame = openingFrame(scene, opening)!;
  const offsets = bayOutline(frame, opening.bay!).map((p) => p.y);
  assert.ok(Math.max(...offsets) <= -60 + 1e-6, `反対側に出ていない (${Math.max(...offsets)})`);
});

test('どの形も壁の幅に収まり、出を超えない', () => {
  for (const shape of BAY_SHAPES) {
    const { scene, opening } = sceneWithWindow({ shape, depth: 450, side: 1 });
    const frame = openingFrame(scene, opening)!;
    const poly = bayOutline(frame, opening.bay!);
    assert.ok(poly.length >= 3, `${shape} の点が足りない`);
    for (const p of poly) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${shape} に非有限の点`);
      assert.ok(Math.abs(p.x - 2000) <= 800 + 1e-6, `${shape} が開口の幅をはみ出す (${p.x})`);
      assert.ok(p.y >= 60 - 1e-6 && p.y <= 510 + 1e-6, `${shape} が出の範囲を外れる (${p.y})`);
    }
  }
});

test('弓型は壁に沿って曲がる（両端が壁に付く）', () => {
  const { scene, opening } = sceneWithWindow({ shape: 'bow', depth: 450, side: 1 });
  const frame = openingFrame(scene, opening)!;
  const poly = bayOutline(frame, opening.bay!);
  assert.ok(Math.abs(poly[0].y - 60) < 1, '始点が壁に付いていない');
  assert.ok(Math.abs(poly[poly.length - 1].y - 60) < 1, '終点が壁に付いていない');
  // 真ん中がいちばん出ている
  const mid = poly[Math.floor(poly.length / 2)];
  assert.ok(Math.abs(mid.y - 510) < 1, `頂点が出に届いていない (${mid.y})`);
});

test('出が 0 の張り出しは持っていないのと同じ', () => {
  const { opening } = sceneWithWindow({ shape: 'box', depth: 0, side: 1 });
  assert.equal(hasBay(opening), false);
});

test('出窓は 3D で壁の外に箱を作る', () => {
  const plain = sceneWithWindow(null);
  const bayed = sceneWithWindow(defaultBay());
  const facesOf = (s: Scene) => buildMesh(s, detectRooms(s));
  const before = facesOf(plain.scene).length;
  const after = facesOf(bayed.scene).length;
  assert.ok(after > before, `面が増えていない (${before} → ${after})`);

  // 壁の外へ出ている面がある
  const outside = facesOf(bayed.scene).filter((f) => f.points.some((p) => p.y > 60 + 1e-6));
  assert.ok(outside.length > 0, '壁の外に何も出ていない');
});

test('張り出しが JSON の往復を生き延びる', () => {
  for (const shape of BAY_SHAPES) {
    const { scene, opening } = sceneWithWindow({ shape, depth: -200, side: -1 });
    const back = deserialize(JSON.parse(JSON.stringify(serialize(scene))));
    assert.deepEqual(back.openings[opening.id].bay, { shape, depth: -200, side: -1 });
  }
});

test('張り出しの無い建具は往復しても null のまま', () => {
  // 古いファイルには欄が無い。**種別を増やしていないので読み替えも要らない**
  const { scene, opening } = sceneWithWindow(null);
  const raw = JSON.parse(JSON.stringify(serialize(scene)));
  delete raw.scene.openings[opening.id].bay;
  assert.equal(deserialize(raw).openings[opening.id].bay, null);
});

test('壊れた張り出しは捨てる', () => {
  const { scene, opening } = sceneWithWindow(null);
  const raw = JSON.parse(JSON.stringify(serialize(scene)));
  raw.scene.openings[opening.id].bay = { shape: 'ufo', depth: 450 };
  assert.equal(deserialize(raw).openings[opening.id].bay, null);
});

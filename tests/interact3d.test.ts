import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleScene } from '../src/io/sample.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { buildMesh } from '../src/render3d/mesh.ts';
import { pickRay, screenRay } from '../src/render3d/ray.ts';
import { highlightOf } from '../src/render3d/interact.ts';
import { paint } from '../src/render3d/paint.ts';
import { defaultCamera, frameAll } from '../src/render3d/camera.ts';
import { sceneBounds, isSelectable, entityExists } from '../src/core/entity.ts';
import { activeLevel } from '../src/core/level.ts';
import { resolveSelection } from '../src/core/selection.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { stubContext } from './stub-context.ts';
import { vec3 } from '../src/render3d/mat4.ts';
import type { EntityRef, Scene } from '../src/core/types.ts';

const W = 1200;
const H = 800;

function framed(scene: Scene) {
  const cam = defaultCamera();
  frameAll(cam, sceneBounds(scene), activeLevel(scene).wallHeight);
  return { cam, mesh: buildMesh(scene, detectRooms(scene)) };
}

/** 画面を走査して、拾えた ref を集める */
function sweep(scene: Scene): EntityRef[] {
  const { cam, mesh } = framed(scene);
  const out: EntityRef[] = [];
  const seen = new Set<string>();
  for (let x = 40; x < W; x += 40) {
    for (let y = 40; y < H; y += 40) {
      const hit = pickRay(screenRay(cam, x, y, W, H), mesh, 50,
        (ref) => ref !== null && isSelectable(scene, ref));
      if (!hit?.ref) continue;
      const key = `${hit.ref.type}:${hit.ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hit.ref);
    }
  }
  return out;
}

test('3D で拾った ref は 2D の選択がそのまま展開できる', () => {
  // **これが成果物。** `resolveSelection` も `ENTITY_KINDS` もインスペクタも
  // 一行も変えずに 3D の選択が通る
  const scene = sampleScene();
  const refs = sweep(scene);
  assert.ok(refs.length > 3, `拾えたのが ${refs.length} 種だけ`);
  for (const ref of refs) {
    assert.ok(entityExists(scene, ref), `${ref.type}:${ref.id} が無い`);
    const sel = resolveSelection(scene, [ref]);
    const total =
      sel.nodeIds.length + sel.openingIds.length + sel.instanceIds.length +
      sel.roomLabelIds.length + sel.shapeIds.length;
    assert.ok(total > 0, `${ref.type} が何にも展開されない`);
  }
});

test('壁・建具・家具のどれもが 3D から拾える', () => {
  const kinds = new Set(sweep(sampleScene()).map((r) => r.type));
  for (const want of ['wall', 'opening', 'blockInstance']) {
    assert.ok(kinds.has(want as EntityRef['type']), `${want} が拾えない`);
  }
});

test('ロックした画層のものは 3D でも選べない', () => {
  const scene = sampleScene();
  scene.layers[LAYER_IDS.furniture].locked = true;
  const kinds = new Set(sweep(scene).map((r) => r.type));
  assert.ok(!kinds.has('blockInstance'), 'ロックした家具が選べてしまう');
  assert.ok(kinds.has('wall'), 'ロックと関係ない壁まで選べなくなった');
});

test('非表示の画層のものは 3D でも選べない', () => {
  const scene = sampleScene();
  scene.layers[LAYER_IDS.opening].visible = false;
  const kinds = new Set(sweep(scene).map((r) => r.type));
  assert.ok(!kinds.has('opening'), '非表示の建具が選べてしまう');
});

test('強調表示を入れても fill と stroke 以外は呼ばれない', () => {
  // **テストの Canvas スタブがオラクルであり続ける**ことが要る。
  // tint は色の文字列を差し替えるだけで、ctx への頼み方は変えない
  const scene = sampleScene();
  const { cam, mesh } = framed(scene);
  const wall = mesh.find((f) => f.ref?.type === 'wall')!.ref!;

  const plain = stubContext();
  paint(plain.ctx, cam, mesh, W, H, {});
  const tinted = stubContext();
  paint(tinted.ctx, cam, mesh, W, H, {
    tint: (ref) => (ref && ref.id === wall.id ? '#2563eb' : null),
  });

  assert.deepEqual(
    [...new Set(tinted.calls)].sort(),
    [...new Set(plain.calls)].sort(),
    '強調表示で ctx の使い方が変わった',
  );
});

test('強調表示は選択中のものだけに掛かる', () => {
  const scene = sampleScene();
  const { mesh } = framed(scene);
  const wall = mesh.find((f) => f.ref?.type === 'wall')!.ref!;
  const other = mesh.find((f) => f.ref?.type === 'blockInstance')!.ref!;

  const editor = {
    store: { selection: [wall] },
    hover: null,
  } as unknown as Parameters<typeof highlightOf>[0];
  const tint = highlightOf(editor);

  assert.ok(tint(wall) !== null, '選択中が強調されない');
  assert.equal(tint(other), null, '選択していないものが強調された');
  assert.equal(tint(null), null, '床が強調された');
});

test('床を拾っても何も選ばれない', () => {
  // 部屋は派生データで実体がない。2D でも部屋の内側をクリックして部屋は選べない
  const scene = sampleScene();
  const { cam, mesh } = framed(scene);
  const floors = mesh.filter((f) => f.bucket === 'floor');
  assert.ok(floors.length > 0);
  for (const f of floors) assert.equal(f.ref, null);
  // 真上から床だけを狙う
  const onlyFloor = pickRay(
    { origin: vec3(2300, 3000, 60_000), direction: vec3(0, 0, -1) },
    floors, 50,
  );
  assert.equal(onlyFloor?.ref ?? null, null);
  void cam;
});

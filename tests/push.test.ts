import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPush, pushAxis, pushTargetOf, MIN_PUSH_SIZE } from '../src/core/push.ts';
import { extrudeShapes } from '../src/core/extrude.ts';
import { FIXTURE_SPECS, outline, type Fixture, type FixtureKind } from '../src/core/fixture.ts';
import { addWall, findOrCreateNode } from '../src/core/ops.ts';
import { defaultAttrs } from '../src/core/attrs.ts';
import { activeLevel, DEFAULT_LEVEL_ID } from '../src/core/level.ts';
import { LAYER_IDS } from '../src/core/layer.ts';
import { rotate, vec, type Vec } from '../src/core/geometry.ts';
import { emptyScene, type Scene } from '../src/core/types.ts';

/**
 * プッシュ/プル（20 段）。**壁の天端を掴んで高さを変える操作の一般化。**
 *
 * 書くのは数値 1〜2 個だけで、ノードも輪郭も動かさない。
 * ここで見るのは「反対側の面が動かないこと」——押し引きの意味そのもの。
 */

const UP = { x: 0, y: 0, z: 1 };
const DOWN = { x: 0, y: 0, z: -1 };

function sceneWith(kind: FixtureKind, over: Partial<Fixture> = {}): { scene: Scene; f: Fixture } {
  const scene = emptyScene();
  const spec = FIXTURE_SPECS[kind];
  const f: Fixture = {
    id: 'f', kind, x: 0, y: 0, angle: 0,
    size: { ...spec.defaultSize }, outline: null,
    base: null, height: null, label: spec.defaultLabel,
    layerId: spec.defaultLayer, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs(),
    ...over,
  };
  scene.fixtures.f = f;
  return { scene, f };
}

const FIXTURE = { type: 'fixture' as const, id: 'f' };

test('上面を押すと背が伸び、下端は動かない', () => {
  const { scene, f } = sceneWith('box', { base: 300, height: 600 });
  const t = pushTargetOf(scene, FIXTURE, UP)!;
  assert.equal(t.what, 'top');
  assert.ok(applyPush(scene, t, 400));
  assert.equal(f.height, 1000);
  assert.equal(f.base, 300, '下端が動いた');
});

test('下面を押すと下端が下がり、上端は動かない', () => {
  const { scene, f } = sceneWith('box', { base: 300, height: 600 });
  const t = pushTargetOf(scene, FIXTURE, DOWN)!;
  assert.equal(t.what, 'bottom');
  // 外向き（下）へ 400 押す
  assert.ok(applyPush(scene, t, 400));
  assert.equal(f.base, -100, '下端が下がっていない');
  assert.equal(f.height, 1000);
  assert.equal(f.base! + f.height!, 900, '上端が動いた');
});

test('同じドラッグ中に何度当てても積み上がらない', () => {
  // **掴んだ時点の値からの差**で計算する。ドラッグ中は毎フレーム呼ばれる
  const { scene, f } = sceneWith('box', { base: 0, height: 600 });
  const t = pushTargetOf(scene, FIXTURE, UP)!;
  applyPush(scene, t, 100);
  applyPush(scene, t, 100);
  applyPush(scene, t, 250);
  assert.equal(f.height, 850);
});

test('矩形の側面を押すと、反対側の面は動かない（回っていても）', () => {
  for (const angle of [0, 0.7, Math.PI / 2, -1.3]) {
    const { scene, f } = sceneWith('box', { angle, size: { w: 600, h: 400 } });
    // ローカル +x の面。ワールドの法線は angle だけ回っている
    const n = rotate(vec(1, 0), angle);
    const t = pushTargetOf(scene, FIXTURE, { x: n.x, y: n.y, z: 0 })!;
    assert.equal(t.what, 'side');
    assert.equal(t.axis, 'x');
    assert.equal(t.sign, 1);

    const before = far(outline(f), vec(-n.x, -n.y));
    applyPush(scene, t, 300);
    assert.equal(f.size.w, 900, '幅が伸びていない');
    assert.equal(f.size.h, 400, '関係のない向きまで変わった');
    const after = far(outline(f), vec(-n.x, -n.y));
    assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 1e-6,
      `角度 ${angle}: 反対側の面が動いた`);
  }
});

/** `dir` の向きにいちばん遠い頂点。反対側の面が動いていないかを見る */
function far(poly: Vec[], dir: Vec): Vec {
  return poly.reduce((best, p) =>
    (p.x * dir.x + p.y * dir.y > best.x * dir.x + best.y * dir.y ? p : best));
}

test('ローカル -x の面を押しても、反対側は動かない', () => {
  const { scene, f } = sceneWith('box', { size: { w: 600, h: 400 } });
  const t = pushTargetOf(scene, FIXTURE, { x: -1, y: 0, z: 0 })!;
  assert.equal(t.sign, -1);
  applyPush(scene, t, 200);
  assert.equal(f.size.w, 800);
  assert.equal(f.x, -100, '中心が伸びたぶんの半分だけ動いていない');
});

test('矩形でない輪郭の側面は押せない', () => {
  // 円・三角・L 形・押し出した形では、1 面だけ動かした結果が `{w, h}` で表せない。
  // **黙って別の形にするより、断る**
  for (const kind of ['cylinder', 'prism', 'sphere', 'stairL'] as FixtureKind[]) {
    const { scene } = sceneWith(kind);
    assert.equal(pushTargetOf(scene, FIXTURE, { x: 1, y: 0, z: 0 }), null, `${kind} の側面が押せる`);
    // 上下は押せる（立体になる種別なら）
    if (FIXTURE_SPECS[kind].solid) {
      assert.ok(pushTargetOf(scene, FIXTURE, UP), `${kind} の上面が押せない`);
    }
  }
});

test('押し出した形は側面を押せないが、上下は押せる', () => {
  const scene = emptyScene();
  scene.shapes.p = {
    id: 'p', shape: 'polyline', closed: true, layerId: LAYER_IDS.shape, attrs: defaultAttrs(),
    points: [vec(0, 0), vec(1000, 0), vec(1000, 1000), vec(0, 1000)],
  } as never;
  const id = extrudeShapes(scene, [{ type: 'shape', id: 'p' }], 800).created[0].id;
  const ref = { type: 'fixture' as const, id };
  // 輪郭は矩形だが**自前の輪郭を持っている**ので、側面は押せない
  assert.equal(pushTargetOf(scene, ref, { x: 1, y: 0, z: 0 }), null);
  const top = pushTargetOf(scene, ref, UP)!;
  applyPush(scene, top, 400);
  assert.equal(scene.fixtures[id].height, 1200);
});

test('立体にならないものは押せない', () => {
  for (const kind of ['void', 'skylight'] as FixtureKind[]) {
    const { scene } = sceneWith(kind);
    assert.equal(pushTargetOf(scene, FIXTURE, UP), null, `${kind} が押せる`);
  }
});

test('壁は天端だけ押せる', () => {
  const scene = emptyScene();
  const wall = addWall(scene, findOrCreateNode(scene, vec(0, 0)), findOrCreateNode(scene, vec(4000, 0)), 120)!;
  const ref = { type: 'wall' as const, id: wall.id };
  assert.equal(pushTargetOf(scene, ref, { x: 0, y: 1, z: 0 }), null, '壁の側面が押せる（厚みの話になる）');
  const t = pushTargetOf(scene, ref, UP)!;
  const start = activeLevel(scene).wallHeight;
  applyPush(scene, t, -500);
  assert.equal(wall.height, start - 500);
});

test('下限を割らない', () => {
  const { scene, f } = sceneWith('box', { base: 0, height: 600 });
  applyPush(scene, pushTargetOf(scene, FIXTURE, UP)!, -99999);
  assert.equal(f.height, MIN_PUSH_SIZE);
  const side = pushTargetOf(scene, FIXTURE, { x: 1, y: 0, z: 0 })!;
  applyPush(scene, side, -99999);
  assert.equal(f.size.w, MIN_PUSH_SIZE);
});

test('押し引きの軸は面の外向き法線', () => {
  const { scene } = sceneWith('box', { angle: 0 });
  assert.deepEqual(pushAxis(pushTargetOf(scene, FIXTURE, UP)!), { x: 0, y: 0, z: 1 });
  assert.deepEqual(pushAxis(pushTargetOf(scene, FIXTURE, DOWN)!), { x: 0, y: 0, z: -1 });
  assert.deepEqual(pushAxis(pushTargetOf(scene, FIXTURE, { x: 0, y: -1, z: 0 })!), { x: 0, y: -1, z: 0 });
});

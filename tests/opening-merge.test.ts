import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addWall, clampOpening, findOrCreateNode, mergeOpeningSpan } from '../src/core/ops.ts';
import { vec } from '../src/core/geometry.ts';
import { emptyScene, type Scene } from '../src/core/types.ts';
import { makeOpening } from './make.ts';

/** 長さ 6000 の壁 1 本だけのシーン */
function wallScene(): { scene: Scene; wallId: string } {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(6000, 0));
  const wall = addWall(scene, a, b, 120)!;
  return { scene, wallId: wall.id };
}

function put(scene: Scene, wallId: string, kind: 'window' | 'door', offset: number, width: number): string {
  const op = makeOpening(wallId, { kind, offset, width });
  scene.openings[op.id] = op;
  return op.id;
}

test('重なる同じ種別はまとめた 1 つの区間になる', () => {
  // [1000,2000] と [1800,2800] → [1000,2800]
  const { scene, wallId } = wallScene();
  const a = put(scene, wallId, 'window', 1500, 1000);
  const got = mergeOpeningSpan(scene, wallId, 'window', 2300, 1000);
  assert.ok(got, '結合しなかった');
  assert.deepEqual(got.absorb, [a]);
  assert.equal(got.offset, 1900);
  assert.equal(got.width, 1800);
});

test('種別が違えば結合しない', () => {
  // **ドアと窓を融かすと、出来たものがどちらでもなくなる**
  const { scene, wallId } = wallScene();
  put(scene, wallId, 'door', 1500, 1000);
  assert.equal(mergeOpeningSpan(scene, wallId, 'window', 2300, 1000), null);
  // 代わりに今までどおり脇へ逃がされる
  const offset = clampOpening(scene, wallId, 2300, 1000);
  assert.ok(offset !== null && offset >= 2500, `逃がし先が ${offset}`);
});

test('触れているだけでは結合しない', () => {
  // 柱の無い位置に窓を 2 つ並べるのは普通の作図
  const { scene, wallId } = wallScene();
  put(scene, wallId, 'window', 1500, 1000); // [1000, 2000]
  assert.equal(mergeOpeningSpan(scene, wallId, 'window', 2500, 1000), null, '隣に置いただけで融けた');
});

test('3 つ以上でも一度にまとめる', () => {
  // 伸びた区間が次の開口に届くので、伸びなくなるまで繰り返す
  const { scene, wallId } = wallScene();
  const a = put(scene, wallId, 'window', 1000, 900); // [550, 1450]
  const b = put(scene, wallId, 'window', 2000, 900); // [1550, 2450]
  const got = mergeOpeningSpan(scene, wallId, 'window', 1500, 1100); // [950, 2050]
  assert.ok(got, '結合しなかった');
  assert.deepEqual(got.absorb.sort(), [a, b].sort());
  assert.equal(got.offset, 1500);
  assert.equal(got.width, 1900);
});

test('まとめた結果が壁に収まらないなら結合しない', () => {
  // 端まで届く開口と結合すると、壁の端に残すべき寸法を食いつぶす
  const { scene, wallId } = wallScene();
  put(scene, wallId, 'window', 300, 560); // [20, 580] 端ぎりぎり
  const got = mergeOpeningSpan(scene, wallId, 'window', 500, 1000); // [0, 1000] → 端を超える
  assert.equal(got, null);
});

test('重なるものが無ければ結合しない', () => {
  const { scene, wallId } = wallScene();
  assert.equal(mergeOpeningSpan(scene, wallId, 'window', 3000, 1000), null);
});

test('結合は幾何だけで、元の開口は触らない', () => {
  const { scene, wallId } = wallScene();
  const a = put(scene, wallId, 'window', 1500, 1000);
  const before = JSON.stringify(scene.openings[a]);
  mergeOpeningSpan(scene, wallId, 'window', 2300, 1000);
  assert.equal(JSON.stringify(scene.openings[a]), before, '問い合わせただけで書き換わった');
});

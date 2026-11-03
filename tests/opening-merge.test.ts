import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addWall, clampOpening, findOrCreateNode, mergeOpeningSpan } from '../src/core/ops.ts';
import { vec } from '../src/core/geometry.ts';
import { emptyScene, type Scene } from '../src/core/types.ts';
import { makeOpening } from './make.ts';
import type { OpeningIdentity } from '../src/core/opening.ts';

/** 長さ 6000 の壁 1 本だけのシーン */
function wallScene(): { scene: Scene; wallId: string } {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(6000, 0));
  const wall = addWall(scene, a, b, 120)!;
  return { scene, wallId: wall.id };
}

function put(
  scene: Scene,
  wallId: string,
  kind: 'window' | 'door',
  offset: number,
  width: number,
  over: Partial<OpeningIdentity> = {},
): string {
  const op = { ...makeOpening(wallId, { kind, offset, width }), ...over };
  scene.openings[op.id] = op;
  return op.id;
}

/** いま置こうとしているもの。既定は `put` と同じ */
function proto(kind: 'window' | 'door', over: Partial<OpeningIdentity> = {}): OpeningIdentity {
  const { id: _i, wallId: _w, offset: _o, width: _d, ...rest } =
    makeOpening('w', { kind, offset: 0, width: 100 });
  return { ...rest, ...over };
}

test('重なる同じ種別はまとめた 1 つの区間になる', () => {
  // [1000,2000] と [1800,2800] → [1000,2800]
  const { scene, wallId } = wallScene();
  const a = put(scene, wallId, 'window', 1500, 1000);
  const got = mergeOpeningSpan(scene, wallId, proto('window'), 2300, 1000);
  assert.ok(got, '結合しなかった');
  assert.deepEqual(got.absorb, [a]);
  assert.equal(got.offset, 1900);
  assert.equal(got.width, 1800);
});

test('種別が違えば結合しない', () => {
  // **ドアと窓を融かすと、出来たものがどちらでもなくなる**
  const { scene, wallId } = wallScene();
  put(scene, wallId, 'door', 1500, 1000);
  assert.equal(mergeOpeningSpan(scene, wallId, proto('window'), 2300, 1000), null);
  // 代わりに今までどおり脇へ逃がされる
  const offset = clampOpening(scene, wallId, 2300, 1000);
  assert.ok(offset !== null && offset >= 2500, `逃がし先が ${offset}`);
});

test('触れているだけでは結合しない', () => {
  // 柱の無い位置に窓を 2 つ並べるのは普通の作図
  const { scene, wallId } = wallScene();
  put(scene, wallId, 'window', 1500, 1000); // [1000, 2000]
  assert.equal(mergeOpeningSpan(scene, wallId, proto('window'), 2500, 1000), null, '隣に置いただけで融けた');
});

test('3 つ以上でも一度にまとめる', () => {
  // 伸びた区間が次の開口に届くので、伸びなくなるまで繰り返す
  const { scene, wallId } = wallScene();
  const a = put(scene, wallId, 'window', 1000, 900); // [550, 1450]
  const b = put(scene, wallId, 'window', 2000, 900); // [1550, 2450]
  const got = mergeOpeningSpan(scene, wallId, proto('window'), 1500, 1100); // [950, 2050]
  assert.ok(got, '結合しなかった');
  assert.deepEqual(got.absorb.sort(), [a, b].sort());
  assert.equal(got.offset, 1500);
  assert.equal(got.width, 1900);
});

test('まとめた結果が壁に収まらないなら結合しない', () => {
  // 端まで届く開口と結合すると、壁の端に残すべき寸法を食いつぶす
  const { scene, wallId } = wallScene();
  put(scene, wallId, 'window', 300, 560); // [20, 580] 端ぎりぎり
  const got = mergeOpeningSpan(scene, wallId, proto('window'), 500, 1000); // [0, 1000] → 端を超える
  assert.equal(got, null);
});

test('重なるものが無ければ結合しない', () => {
  const { scene, wallId } = wallScene();
  assert.equal(mergeOpeningSpan(scene, wallId, proto('window'), 3000, 1000), null);
});

test('結合は幾何だけで、元の開口は触らない', () => {
  const { scene, wallId } = wallScene();
  const a = put(scene, wallId, 'window', 1500, 1000);
  const before = JSON.stringify(scene.openings[a]);
  mergeOpeningSpan(scene, wallId, proto('window'), 2300, 1000);
  assert.equal(JSON.stringify(scene.openings[a]), before, '問い合わせただけで書き換わった');
});

test('窓台が違えば融けない（掃き出し窓と腰窓）', () => {
  // **ここが今回防ぐ壊れ方。** 融けると吸収された側の窓台が黙って消える。
  // 同じ `window` でも、窓台 0 の掃き出し窓と 800 の腰窓は別のもの
  const { scene, wallId } = wallScene();
  const sweep = put(scene, wallId, 'window', 1500, 1000, { sillHeight: 0 });
  assert.equal(
    mergeOpeningSpan(scene, wallId, proto('window', { sillHeight: 800 }), 2300, 1000),
    null,
    '窓台が違うのに融けた',
  );
  // 同じ窓台どうしなら今までどおり融ける
  const same = mergeOpeningSpan(scene, wallId, proto('window', { sillHeight: 0 }), 2300, 1000);
  assert.deepEqual(same?.absorb, [sweep]);
});

test('建具符号が違えば融けない', () => {
  // 符号は「平面では同じ記号になる建具」を区別する唯一の手がかり。
  // 融けると、どちらの符号で呼ばれていたか分からなくなる
  const { scene, wallId } = wallScene();
  put(scene, wallId, 'window', 1500, 1000, { designation: 'AW-1' });
  assert.equal(
    mergeOpeningSpan(scene, wallId, proto('window', { designation: 'AW-2' }), 2300, 1000),
    null,
  );
});

test('張り出し・枚数・画層・素材が違えば融けない', () => {
  const cases: [string, Partial<OpeningIdentity>][] = [
    ['張り出し', { bay: { shape: 'box', depth: 450, side: 1 } }],
    ['枚数', { leaves: 4 }],
    ['画層', { layerId: 'shape' }],
    ['高さ', { height: 1200 }],
    ['開き勝手', { flipX: true }],
  ];
  for (const [name, over] of cases) {
    const { scene, wallId } = wallScene();
    put(scene, wallId, 'window', 1500, 1000);
    assert.equal(
      mergeOpeningSpan(scene, wallId, proto('window', over), 2300, 1000),
      null,
      `${name}が違うのに融けた`,
    );
  }
});

test('素材が違えば融けない', () => {
  const { scene, wallId } = wallScene();
  const id = put(scene, wallId, 'window', 1500, 1000);
  scene.openings[id].attrs.materialRef = 'm-1';
  assert.equal(mergeOpeningSpan(scene, wallId, proto('window'), 2300, 1000), null);
});

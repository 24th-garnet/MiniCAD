import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene } from '../src/core/types.ts';
import {
  addWall, clampOpening, findOrCreateNode, wallArc, wallDirAtLength,
  wallLength, wallPointAtLength,
} from '../src/core/ops.ts';
import { dist, vec } from '../src/core/geometry.ts';
import { LAYER_IDS } from '../src/core/layer.ts';

/**
 * 円弧壁（23 段）。ワイヤー 5 枚目「例）壁、**円弧壁**、壁結合などは、
 * 通常モードを利用する前提」。
 *
 * **近似（短い直線の連なり）をやめた理由がここにある。** 近似だと
 * 「分割線をまたぐ開口は削除する」規則に当たって、**円弧壁に窓が置けない**。
 * 本物として持てば、開口の 1 次元の物差しが弧長になるだけで通る。
 */

/** 半径 500 の半円の壁。弦は 1000、弧長は 500π ≒ 1571 */
function semicircle(thickness = 100) {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(1000, 0));
  const wall = addWall(scene, a, b, thickness, LAYER_IDS.wall, 1)!;
  return { scene, wall };
}

test('壁の長さは弧長であって、弦ではない', () => {
  // **ここを弦のままにすると、置いた窓が黙って動く。**
  // `clampOpening` も `wallSpans` も offset を 0〜wallLength の座標として扱う
  const { scene, wall } = semicircle();
  assert.ok(Math.abs(wallLength(scene, wall) - Math.PI * 500) < 1e-6,
    `弧長でない (${wallLength(scene, wall)})`);
});

test('直線の壁はこれまでどおり', () => {
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(3000, 4000));
  const wall = addWall(scene, a, b, 100)!;
  assert.equal(wall.bulge, 0);
  assert.equal(wallArc(scene, wall), null, '直線なのに円弧が出た');
  assert.ok(Math.abs(wallLength(scene, wall) - 5000) < 1e-9);
});

test('弦より長い窓が置ける', () => {
  // **近似をやめた理由そのもの。** 半径 3000 を 11.25 度で割ると 1 本 589mm。
  // 近似だと 1600mm の窓は 3 本をまたぎ、「またぐ開口は削除」で消える
  const { scene, wall } = semicircle();
  const chord = 1000;
  const width = 1200; // 弦より広い
  assert.ok(width > chord, '前提が崩れている');
  const offset = clampOpening(scene, wall.id, wallLength(scene, wall) / 2, width);
  assert.ok(offset !== null, '弦より広い窓が置けない');
  assert.ok(Math.abs(offset - Math.PI * 250) < 1, `真ん中に来ない (${offset})`);
});

test('弧長の座標が円弧の上の点になる', () => {
  const { scene, wall } = semicircle();
  const total = wallLength(scene, wall);
  const arc = wallArc(scene, wall)!;
  // 端はノードの位置
  assert.ok(dist(wallPointAtLength(scene, wall, 0), vec(0, 0)) < 1e-6, '始点');
  assert.ok(dist(wallPointAtLength(scene, wall, total), vec(1000, 0)) < 1e-6, '終点');
  // 真ん中は矢高の先（正の膨らみは右＝下へ膨らむ）
  const mid = wallPointAtLength(scene, wall, total / 2);
  assert.ok(Math.abs(mid.x - 500) < 1e-6 && Math.abs(mid.y + 500) < 1e-6,
    `頂点が違う ${JSON.stringify(mid)}`);
  // どの点も中心から半径のところにある
  for (let i = 0; i <= 10; i++) {
    const p = wallPointAtLength(scene, wall, (total * i) / 10);
    assert.ok(Math.abs(dist(p, arc.center) - arc.radius) < 1e-6, `${i}/10 が円の上に無い`);
  }
});

test('向きは、その点の接線', () => {
  const { scene, wall } = semicircle();
  const total = wallLength(scene, wall);
  // 始点では真下を向く（下へ膨らむ半円の出口）
  const d0 = wallDirAtLength(scene, wall, 0);
  assert.ok(Math.abs(d0.x) < 1e-6 && Math.abs(d0.y + 1) < 1e-6, `始点の向き ${JSON.stringify(d0)}`);
  // 真ん中では +x
  const dm = wallDirAtLength(scene, wall, total / 2);
  assert.ok(Math.abs(dm.x - 1) < 1e-6 && Math.abs(dm.y) < 1e-6, `中央の向き ${JSON.stringify(dm)}`);
  // 終点では真上
  const d1 = wallDirAtLength(scene, wall, total);
  assert.ok(Math.abs(d1.x) < 1e-6 && Math.abs(d1.y - 1) < 1e-6, `終点の向き ${JSON.stringify(d1)}`);
  // 直線なら弦の向き
  const scene2 = emptyScene();
  const a = findOrCreateNode(scene2, vec(0, 0));
  const b = findOrCreateNode(scene2, vec(0, 2000));
  const straight = addWall(scene2, a, b, 100)!;
  const ds = wallDirAtLength(scene2, straight, 500);
  assert.ok(Math.abs(ds.x) < 1e-9 && Math.abs(ds.y - 1) < 1e-9);
});

test('同じ 2 ノードの間に、直線と円弧を別々に置ける', () => {
  // レンズ形の部屋が作れるために要る。いまは (a,b) が同じなら既存を返していた
  const scene = emptyScene();
  const a = findOrCreateNode(scene, vec(0, 0));
  const b = findOrCreateNode(scene, vec(1000, 0));
  const straight = addWall(scene, a, b, 100)!;
  const arc = addWall(scene, a, b, 100, LAYER_IDS.wall, 1)!;
  assert.notEqual(straight.id, arc.id, '円弧が直線に吸収された');
  assert.equal(Object.keys(scene.walls).length, 2);
  // 同じ膨らみなら、これまでどおり使い回す
  const again = addWall(scene, a, b, 100, LAYER_IDS.wall, 1)!;
  assert.equal(again.id, arc.id, '同じ円弧が二重に出来た');
});

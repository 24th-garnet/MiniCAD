import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vec } from '../src/core/geometry.ts';
import { Viewport } from '../src/render/viewport.ts';

/**
 * 画面の寸法が変わったときの見え方。
 *
 * **MiniCAD はホストの箱の中で生きる**ので、寸法はいつでも変わりうる
 * ——ホストの欄が開く、窓が狭まる、分割に切り替わる。単体のページでは
 * 組んだあと箱が変わらないので、ここが壊れていても気づけなかった。
 */

/** 800×600 の画面に、ワールド原点を中心に置いた状態 */
const centered = (): Viewport => {
  const vp = new Viewport();
  vp.resize(800, 600);
  vp.scale = 0.1;
  vp.origin = vec(400, 300);
  return vp;
};

test('縮めても倍率は変わらない（CAD の流儀）', () => {
  const vp = centered();
  vp.resize(400, 300);
  assert.equal(vp.scale, 0.1);
});

test('縮めても、画面の中心にあったものが中心に残る', () => {
  const vp = centered();
  const before = vp.toWorld(vec(vp.width / 2, vp.height / 2));
  vp.resize(400, 300);
  const after = vp.toWorld(vec(vp.width / 2, vp.height / 2));
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 1e-9,
    `中心が ${JSON.stringify(before)} から ${JSON.stringify(after)} へ動いた`);
});

test('広げても、画面の中心にあったものが中心に残る', () => {
  const vp = centered();
  const before = vp.toWorld(vec(vp.width / 2, vp.height / 2));
  vp.resize(1400, 900);
  const after = vp.toWorld(vec(vp.width / 2, vp.height / 2));
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 1e-9, '広げたら中心が動いた');
});

/**
 * **これが本番で出ていた症状。** 8×6m の間取りを収めてから箱を縮めると、
 * 以前は図面が枠の外へ出ていた。
 */
test('間取りを収めてから縮めても、枠の外へ出ない', () => {
  const vp = new Viewport();
  vp.resize(1020, 530);
  const bounds = { min: vec(0, 0), max: vec(8000, 6000) };
  vp.fit(bounds);

  vp.resize(568, 530);
  const center = vp.toWorld(vec(vp.width / 2, vp.height / 2));
  // 間取りの重心が画面の中心にある＝どちらの側にも偏っていない
  assert.ok(Math.abs(center.x - 4000) < 1e-6 && Math.abs(center.y - 3000) < 1e-6,
    `間取りの中心が画面の中心から外れた: ${JSON.stringify(center)}`);

  // 幅は足りないので左右は切れるが、**上下は丸ごと入っている**
  const seen = vp.visibleBounds();
  assert.ok(seen.min.y <= 0 && seen.max.y >= 6000, '縦が入りきっていない');
});

test('寸法を知る前の 1 回目は原点を動かさない（このあと fit が来る）', () => {
  const vp = new Viewport();
  vp.origin = vec(0, 0);
  vp.resize(800, 600);
  assert.deepEqual(vp.origin, vec(0, 0));
});

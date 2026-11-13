import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraEye, defaultCamera, faceYaw, flyOver, lookAround, orbit, walkTo,
} from '../src/render3d/camera.ts';
import { vec3 } from '../src/render3d/mat4.ts';

/**
 * ウォークスルー（一人称で歩き回る）のカメラ。
 *
 * ワイヤー `20_案件詳細_現状図面 4 枚目`：
 * 　「**移動位置をクリックすれば、視点の xy 座標が移動する**」
 * 　「マウス操作で、**視点の向きを上下左右に移動できる**」
 *
 * **軌道カメラのまま一人称にする。** 型を増やすと投影・クリップ・深度ソートの
 * 経路が 2 本になり、片方だけ直す事故が起きる（`camera.ts` の `flyOver` の注記）。
 */

/** 歩いている位置に立つ。目線 1500mm、水平を向く */
const standing = () => {
  const cam = defaultCamera();
  flyOver(cam, vec3(4000, 3000, 0), 1500);
  return cam;
};

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;

test('見回しても、目は 1mm も動かない', () => {
  const cam = standing();
  const before = cameraEye(cam);

  lookAround(cam, 120, 40);
  const after = cameraEye(cam);

  for (const k of ['x', 'y', 'z'] as const) {
    assert.ok(
      near(after[k], before[k]),
      `目の ${k} が ${before[k]} → ${after[k]} と動いた`,
    );
  }
});

test('見回すと向きは変わる（固定しているのは目だけ）', () => {
  const cam = standing();
  const before = { yaw: cam.yaw, pitch: cam.pitch, target: { ...cam.target } };

  lookAround(cam, 120, 40);

  assert.ok(!near(cam.yaw, before.yaw), '左右に振れていない');
  assert.ok(!near(cam.pitch, before.pitch), '上下に振れていない');
  assert.ok(
    Math.hypot(cam.target.x - before.target.x, cam.target.y - before.target.y) > 100,
    '注視点が動いていない（目を軸に回っていない）',
  );
  // 見ている距離は変わらない
  assert.ok(near(cam.distance, standing().distance), '距離が変わった');
});

test('同じドラッグでも、回すと目が動き、見回すと動かない', () => {
  // **これがこの仕事の中身。** いまの「歩く」はドラッグで目が 742mm 滑っていた
  const a = standing();
  const b = standing();
  const start = cameraEye(a);

  orbit(a, 100, 0);
  lookAround(b, 100, 0);

  const moved = Math.hypot(cameraEye(a).x - start.x, cameraEye(a).y - start.y);
  const stayed = Math.hypot(cameraEye(b).x - start.x, cameraEye(b).y - start.y);
  assert.ok(moved > 500, `回したのに目が ${Math.round(moved)}mm しか動かない（前提）`);
  assert.ok(stayed < 1e-6, `見回したのに目が ${Math.round(stayed)}mm 動いた`);
});

test('真上・真下では止まる（lookAt が NaN になるため）', () => {
  const cam = standing();
  // 上へ大きく振り続ける
  for (let i = 0; i < 100; i++) lookAround(cam, 0, -100);
  assert.ok(Math.abs(cam.pitch) < Math.PI / 2, `pitch が ${cam.pitch}`);
  const eye = cameraEye(cam);
  for (const k of ['x', 'y', 'z'] as const) {
    assert.ok(Number.isFinite(eye[k]), `目の ${k} が有限でない`);
  }
});

test('歩くと目の xy だけが移る。高さも向きも変わらない', () => {
  const cam = standing();
  const before = { ...cameraEye(cam) };
  const look = { yaw: cam.yaw, pitch: cam.pitch, distance: cam.distance };

  walkTo(cam, 9000, 1000);
  const after = cameraEye(cam);

  assert.ok(near(after.x, 9000), `目の x が ${after.x}`);
  assert.ok(near(after.y, 1000), `目の y が ${after.y}`);
  assert.ok(near(after.z, before.z), `目の高さが ${before.z} → ${after.z} と変わった`);
  assert.deepEqual(
    { yaw: cam.yaw, pitch: cam.pitch, distance: cam.distance }, look,
    '向きか距離が変わった',
  );
});

test('歩いたあとに見回しても、立っている場所は動かない', () => {
  const cam = standing();
  walkTo(cam, 9000, 1000);
  const stood = cameraEye(cam);
  lookAround(cam, 200, -30);
  const after = cameraEye(cam);
  for (const k of ['x', 'y', 'z'] as const) {
    assert.ok(near(after[k], stood[k]), `見回したら ${k} が動いた`);
  }
});

test('有限でない行き先は断る（カメラを壊さない）', () => {
  const cam = standing();
  const before = { ...cam.target };
  walkTo(cam, Number.NaN, 0);
  assert.deepEqual(cam.target, before, 'NaN でカメラが壊れた');
});

test('方角を置き直しても、立っている場所は動かない', () => {
  const cam = standing();
  walkTo(cam, 9000, 1000);
  const stood = cameraEye(cam);
  const pitch = cam.pitch;

  faceYaw(cam, 2.5);

  assert.equal(cam.yaw, 2.5, '方角が入っていない');
  assert.equal(cam.pitch, pitch, '俯角まで変わった');
  for (const k of ['x', 'y', 'z'] as const) {
    assert.ok(near(cameraEye(cam)[k], stood[k]), `向きを変えたら ${k} が動いた`);
  }
});

test('置き直した方角が、そのまま視線の向きになる', () => {
  const cam = standing();
  faceYaw(cam, 2.5);
  const eye = cameraEye(cam);
  // 目から注視点へのベクトルの方位角が、入れた yaw の逆向き
  //（目は注視点から dir(yaw) の向きに distance だけ離れた位置にある）
  const heading = Math.atan2(cam.target.y - eye.y, cam.target.x - eye.x);
  const want = 2.5 - Math.PI;
  assert.ok(near(heading, want, 1e-6), `視線の方位が ${heading}、期待は ${want}`);
});

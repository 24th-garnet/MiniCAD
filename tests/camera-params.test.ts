import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCameraParams, cameraParams, defaultCamera } from '../src/render3d/camera.ts';
import { vec3 } from '../src/render3d/mat4.ts';

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;

test('カメラの引数は往復する', () => {
  // **ホストに渡して戻ってくる形。** 往復で姿勢が変わると、
  // AI パースの画面で数字を触っていないのに絵が動く
  const cam = defaultCamera();
  cam.yaw = 0.7;
  cam.pitch = 0.4;
  cam.distance = 12000;
  cam.fovY = 0.9;

  const p = cameraParams(cam);
  const back = defaultCamera();
  applyCameraParams(back, p);

  assert.ok(near(back.yaw, cam.yaw, 1e-9), `yaw ${back.yaw}`);
  assert.ok(near(back.pitch, cam.pitch, 1e-9), `pitch ${back.pitch}`);
  assert.ok(near(back.distance, cam.distance, 1e-6), `distance ${back.distance}`);
  assert.ok(near(back.fovY, cam.fovY, 1e-9), `fov ${back.fovY}`);
  assert.deepEqual(back.target, cam.target);
});

test('画角は 1〜90 度に収まる', () => {
  // ワイヤーのスライダが 0〜90 度。0 は投影が潰れるので 1 で止める
  const cam = defaultCamera();
  applyCameraParams(cam, { fovDeg: 200 });
  assert.ok(near((cam.fovY * 180) / Math.PI, 90));
  applyCameraParams(cam, { fovDeg: 0 });
  assert.ok(near((cam.fovY * 180) / Math.PI, 1));
  applyCameraParams(cam, { fovDeg: NaN });
  assert.ok(near((cam.fovY * 180) / Math.PI, 1), '壊れた値で姿勢が変わった');
});

test('真上から見下ろしても姿勢が壊れない', () => {
  // **真上・真下では up と視線が平行になり lookAt が NaN になる。**
  // 外から来た値でそこに入れないよう、手前で止める
  const cam = defaultCamera();
  applyCameraParams(cam, { target: vec3(0, 0, 0), eye: vec3(0, 0, 10000) });
  assert.ok(Number.isFinite(cam.pitch));
  assert.ok(Math.abs(cam.pitch) < Math.PI / 2, `pitch が ${cam.pitch}`);
});

test('一部だけ渡すと、渡していないものは変わらない', () => {
  const cam = defaultCamera();
  const before = { ...cam };
  applyCameraParams(cam, { fovDeg: 60 });
  assert.equal(cam.yaw, before.yaw);
  assert.equal(cam.distance, before.distance);
  assert.deepEqual(cam.target, before.target);
});

test('平行投影に切り替えられる', () => {
  const cam = defaultCamera();
  applyCameraParams(cam, { mode: 'ortho' });
  assert.equal(cam.mode, 'ortho');
  assert.equal(cameraParams(cam).mode, 'ortho');
});

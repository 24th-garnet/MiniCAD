import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultCamera, viewProjection, type Camera3D } from '../src/render3d/camera.ts';
import { screenRay, rayPointAt } from '../src/render3d/ray.ts';
import { sub3, transformPoint, vec3, type Vec3 } from '../src/render3d/mat4.ts';

const W = 1440;
const H = 900;

const dist = (a: Vec3, b: Vec3): number => {
  const d = sub3(a, b);
  return Math.hypot(d.x, d.y, d.z);
};

/** paint と同じ式でワールドの点を CSS ピクセルに落とす（DPR は 1） */
function toScreen(cam: Camera3D, p: Vec3): { x: number; y: number } | null {
  const view = viewProjection(cam, W, H);
  const q = transformPoint(view.matrix, p);
  if (q.w <= 0) return null;
  return { x: ((q.x / q.w) * 0.5 + 0.5) * W, y: (0.5 - (q.y / q.w) * 0.5) * H };
}

/** レイから点までの距離。乗っていれば 0 に近い */
function distanceToRay(cam: Camera3D, sx: number, sy: number, p: Vec3): number {
  const ray = screenRay(cam, sx, sy, W, H);
  const v = sub3(p, ray.origin);
  const t = v.x * ray.direction.x + v.y * ray.direction.y + v.z * ray.direction.z;
  return dist(p, rayPointAt(ray, t));
}

const perspective = (): Camera3D => defaultCamera();
const ortho = (): Camera3D => ({ ...defaultCamera(), mode: 'ortho' });

test('画面の中心のレイは注視点を通る（透視）', () => {
  const cam = perspective();
  assert.ok(distanceToRay(cam, W / 2, H / 2, cam.target) < 1e-6);
});

test('画面の中心のレイは注視点を通る（平行投影）', () => {
  const cam = ortho();
  assert.ok(distanceToRay(cam, W / 2, H / 2, cam.target) < 1e-6);
});

/**
 * **このフェーズでいちばん大事なテスト。**
 *
 * `screenRay` を自前で導き直して確かめると、同じ思い違いを 2 回書くだけになる。
 * 投影 → 画面座標 → レイ、と回して元の点に戻ることを見れば、
 * `viewProjection` と `screenRay` がずれた瞬間に落ちる。
 */
test('投影して画面座標に直し、そこからレイを作ると元の点に戻る（透視）', () => {
  const cam = perspective();
  const points = [
    vec3(0, 0, 0),
    vec3(4000, 3000, 2400),
    vec3(-2500, 1800, 600),
    vec3(8000, -1200, 0),
    vec3(1, 1, 1),
  ];
  for (const p of points) {
    const s = toScreen(cam, p);
    assert.ok(s, `${JSON.stringify(p)} が画面に出ない`);
    const off = distanceToRay(cam, s.x, s.y, p);
    assert.ok(off < 1e-6, `レイから ${off.toFixed(6)}mm ずれた: ${JSON.stringify(p)}`);
  }
});

test('投影して画面座標に直し、そこからレイを作ると元の点に戻る（平行投影）', () => {
  const cam = ortho();
  for (const p of [vec3(0, 0, 0), vec3(4000, 3000, 2400), vec3(-2500, 1800, 600)]) {
    const s = toScreen(cam, p);
    assert.ok(s);
    const off = distanceToRay(cam, s.x, s.y, p);
    assert.ok(off < 1e-6, `レイから ${off.toFixed(6)}mm ずれた`);
  }
});

test('カメラを回しても往復する', () => {
  // 1 つの姿勢だけで合わせても、基底の取り違えは見つからない
  const p = vec3(3000, 2000, 1500);
  for (const yaw of [0, 1, 2.5, -1.3, Math.PI]) {
    for (const pitch of [-1.2, -0.3, 0.2, 0.9, 1.5]) {
      const cam: Camera3D = { ...defaultCamera(), yaw, pitch };
      const s = toScreen(cam, p);
      if (!s) continue;
      const off = distanceToRay(cam, s.x, s.y, p);
      assert.ok(off < 1e-6, `yaw=${yaw} pitch=${pitch} で ${off.toFixed(6)}mm ずれた`);
    }
  }
});

test('平行投影ではどの画素でもレイの向きが視線と同じ', () => {
  const cam = ortho();
  const center = screenRay(cam, W / 2, H / 2, W, H).direction;
  for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H], [123, 456]]) {
    const d = screenRay(cam, x, y, W, H).direction;
    assert.ok(dist(d, center) < 1e-12, `向きが揃っていない (${x},${y})`);
  }
});

test('透視では画素ごとにレイの向きが変わる', () => {
  const cam = perspective();
  const a = screenRay(cam, 0, 0, W, H).direction;
  const b = screenRay(cam, W, H, W, H).direction;
  assert.ok(dist(a, b) > 0.1, '透視なのに向きが同じ');
});

test('レイの向きは単位ベクトル', () => {
  for (const cam of [perspective(), ortho()]) {
    for (const [x, y] of [[0, 0], [W / 2, H / 2], [W, H]]) {
      const d = screenRay(cam, x, y, W, H).direction;
      assert.ok(Math.abs(Math.hypot(d.x, d.y, d.z) - 1) < 1e-12);
    }
  }
});

test('画面の大きさが 0 でも有限の値を返す', () => {
  // 3D を開く前のキャンバスは 0x0。NaN を外に出さない
  for (const cam of [perspective(), ortho()]) {
    const r = screenRay(cam, 0, 0, 0, 0);
    for (const v of [r.origin, r.direction]) {
      assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z));
    }
  }
});

test('真上から見下ろしても NaN にならない', () => {
  // pitch は ±(π/2 − 0.01) で止めてあるが、境界で基底が潰れないことを見る
  const cam: Camera3D = { ...defaultCamera(), pitch: Math.PI / 2 - 0.01 };
  const r = screenRay(cam, W / 2, H / 2, W, H);
  assert.ok(Number.isFinite(r.direction.x) && Number.isFinite(r.direction.z));
  assert.ok(distanceToRay(cam, W / 2, H / 2, cam.target) < 1e-6);
});

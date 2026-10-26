import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraBasis, defaultCamera, viewProjection, type Camera3D } from '../src/render3d/camera.ts';
import { screenRay, rayPointAt, rayFace, rayHits, pickRay, rayPlane, rayVerticalAt, type Ray3 } from '../src/render3d/ray.ts';
import { buildMesh, type Face3 } from '../src/render3d/mesh.ts';
import { detectRooms } from '../src/core/rooms.ts';
import { sampleScene } from '../src/io/sample.ts';
import type { EntityRef } from '../src/core/types.ts';
import { normalize3, sub3, transformPoint, vec3, type Vec3 } from '../src/render3d/mat4.ts';

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

// --- 面との交差 -------------------------------------------------------------

/** 上向きの床 1 枚を手で組む */
function floorFace(poly: { x: number; y: number }[], z = 0, ref: EntityRef | null = null): Face3 {
  return {
    points: poly.map((p) => vec3(p.x, p.y, z)),
    normal: vec3(0, 0, 1),
    color: '#fff',
    bucket: 'floor',
    doubleSided: true,
    ref,
    levelId: 'lv-1',
  };
}

/** 真下を向いたレイ */
const down = (x: number, y: number, z = 10_000): Ray3 => ({
  origin: vec3(x, y, z),
  direction: vec3(0, 0, -1),
});

test('多角形の内側に当たり、外側には当たらない', () => {
  const f = floorFace([{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }]);
  assert.ok(rayFace(down(2000, 1500), f, 1) !== null, '内側で当たらない');
  assert.equal(rayFace(down(5000, 1500), f, 1), null, '外側で当たった');
});

test('コの字の床の凹んだ側では当たらない', () => {
  // **扇状分割だとここが当たる。** 床は room.innerPolygon で L 字やコの字に
  // なるので、凹多角形を正しく扱えないと「見えていない床を掴む」ことになる。
  //
  // (2500, 2000) は部屋の外（コの字の切り欠きの中）だが、頂点 0 からの
  // 扇状分割では三角形の内側に入ってしまう。この 1 点が
  // 「三角形分割を書かない」という判断を守っている。
  const U = floorFace([
    { x: 0, y: 0 },
    { x: 4000, y: 0 },
    { x: 4000, y: 1000 },
    { x: 1000, y: 1000 },
    { x: 1000, y: 3000 },
    { x: 4000, y: 3000 },
    { x: 4000, y: 4000 },
    { x: 0, y: 4000 },
  ]);
  assert.ok(rayFace(down(500, 2000), U, 1) !== null, 'コの字の背で当たらない');
  assert.ok(rayFace(down(3000, 500), U, 1) !== null, 'コの字の腕で当たらない');
  assert.equal(rayFace(down(2500, 2000), U, 1), null, '切り欠きの中で当たった');
});

test('交点までの距離が正しい', () => {
  const f = floorFace([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }], 500);
  const t = rayFace({ origin: vec3(500, 500, 2500), direction: vec3(0, 0, -1) }, f, 1);
  assert.ok(t !== null);
  assert.ok(Math.abs(t - 2000) < 1e-9, `距離が ${t}`);
});

test('面と平行なレイは当たらない', () => {
  const f = floorFace([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }]);
  assert.equal(rayFace({ origin: vec3(500, 500, 100), direction: vec3(1, 0, 0) }, f, 1), null);
});

test('視点の後ろの面は当たらない', () => {
  const f = floorFace([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }]);
  // 上を向いたレイ。床は後ろにある
  assert.equal(rayFace({ origin: vec3(500, 500, 100), direction: vec3(0, 0, 1) }, f, 1), null);
});

test('背面は当たらない', () => {
  // 下から上向きの床（両面でない）
  const f = { ...floorFace([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }]) };
  delete (f as { doubleSided?: boolean }).doubleSided;
  assert.equal(rayFace({ origin: vec3(500, 500, -100), direction: vec3(0, 0, 1) }, f, 1), null);
});

test('両面の床は下からも当たる', () => {
  const f = floorFace([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }]);
  assert.ok(rayFace({ origin: vec3(500, 500, -100), direction: vec3(0, 0, 1) }, f, 1) !== null);
});

test('層の順ではなく実際に手前の面が返る', () => {
  // 家具（上）と床（下）。BUCKET_ORDER では床が先に描かれるが、拾うのは手前
  const low = floorFace([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }], 0,
    { type: 'wall', id: 'low' });
  const high = { ...floorFace([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }], 700,
    { type: 'blockInstance', id: 'high' }), bucket: 'furniture' as const };
  const hit = pickRay(down(500, 500), [low, high], 1);
  assert.equal(hit?.ref?.id, 'high', '奥の面を拾っている');
});

test('accept が false を返す面は読み飛ばして奥を拾う', () => {
  // ロックした画層のものは選べないが、その奥のものは選べてほしい
  const low = floorFace([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }], 0,
    { type: 'wall', id: 'low' });
  const high = floorFace([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }], 700,
    { type: 'wall', id: 'locked' });
  const hit = pickRay(down(500, 500), [low, high], 1, (ref) => ref?.id !== 'locked');
  assert.equal(hit?.ref?.id, 'low');
});

test('当たった面は手前から順に並ぶ', () => {
  const faces = [0, 700, 1400].map((z) =>
    floorFace([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }], z,
      { type: 'wall', id: `z${z}` }),
  );
  const hits = rayHits(down(500, 500), faces, 1);
  assert.deepEqual(hits.map((h) => h.ref!.id), ['z1400', 'z700', 'z0']);
});

test('縦の面も拾える（軸を落とす先が変わる）', () => {
  // 法線が x 向きの壁。dominant axis が z 以外になる経路
  const wall: Face3 = {
    points: [vec3(0, 0, 0), vec3(0, 0, 2400), vec3(0, 4000, 2400), vec3(0, 4000, 0)],
    normal: vec3(-1, 0, 0),
    color: '#fff',
    bucket: 'wall',
    ref: { type: 'wall', id: 'w' },
    levelId: 'lv-1',
  };
  assert.ok(rayFace({ origin: vec3(-500, 2000, 1200), direction: vec3(1, 0, 0) }, wall, 1) !== null);
  assert.equal(rayFace({ origin: vec3(-500, 9000, 1200), direction: vec3(1, 0, 0) }, wall, 1), null,
    '面の外で当たった');
});

test('サンプル間取りを真上から拾うと床か家具に当たる', () => {
  const scene = sampleScene();
  const mesh = buildMesh(scene, detectRooms(scene));
  const hit = pickRay({ origin: vec3(2300, 3000, 50_000), direction: vec3(0, 0, -1) }, mesh, 50);
  assert.ok(hit, 'LDK の真上から拾えない');
  assert.ok(['floor', 'furniture'].includes(hit.face.bucket), `当たったのは ${hit.face.bucket}`);
});

// --- ドラッグの面と軸 -------------------------------------------------------

test('掴んだ点を通る水平面との交点が取れる', () => {
  const cam = perspective();
  const grab = vec3(2000, 1500, 700);
  const plane = { origin: grab, normal: vec3(0, 0, 1) };
  const s = toScreen(cam, grab);
  assert.ok(s);
  const at = rayPlane(screenRay(cam, s.x, s.y, W, H), plane);
  assert.ok(at, '交点が取れない');
  assert.ok(dist(at, grab) < 1e-6, `掴んだ点から ${dist(at, grab).toFixed(6)}mm ずれた`);
});

test('掴んだ点はカーソルの下に留まる', () => {
  // **ドラッグの手触りそのもの。** 画面を動かした先で交点を取り直すと、
  // その点がちょうどカーソルの下に来る
  const cam = perspective();
  const grab = vec3(2000, 1500, 700);
  const plane = { origin: grab, normal: vec3(0, 0, 1) };
  const from = toScreen(cam, grab)!;

  for (const [dx, dy] of [[120, 0], [0, 90], [-200, 140], [60, -70]]) {
    const at = rayPlane(screenRay(cam, from.x + dx, from.y + dy, W, H), plane);
    assert.ok(at, 'カーソル先で交点が取れない');
    // 動かした先の点を投影し直すと、カーソルの位置に戻る
    const back = toScreen(cam, at)!;
    assert.ok(Math.hypot(back.x - (from.x + dx), back.y - (from.y + dy)) < 1e-6,
      `カーソルの下に留まっていない (${dx},${dy})`);
    assert.ok(Math.abs(at.z - grab.z) < 1e-9, '面から外れた');
  }
});

test('視線が面と平行に近いと交点を返さない', () => {
  // 交点は ±∞ に飛ぶ。null を返して直前の変位を保つのが正しい
  const ray: Ray3 = { origin: vec3(0, 0, 1000), direction: vec3(1, 0, 0) };
  assert.equal(rayPlane(ray, { origin: vec3(0, 0, 0), normal: vec3(0, 0, 1) }), null);

  // わずかに傾いただけでもまだ返さない（既定はおよそ 3 度）
  const almost: Ray3 = { origin: vec3(0, 0, 1000), direction: normalize3(vec3(1, 0, -0.02)) };
  assert.equal(rayPlane(almost, { origin: vec3(0, 0, 0), normal: vec3(0, 0, 1) }), null);

  // 十分に傾けば返す
  const ok: Ray3 = { origin: vec3(0, 0, 1000), direction: normalize3(vec3(1, 0, -1)) };
  assert.ok(rayPlane(ok, { origin: vec3(0, 0, 0), normal: vec3(0, 0, 1) }) !== null);
});

test('鉛直面との交点が取れる（建具を壁に沿わせる）', () => {
  // 壁が x 方向に伸びているとき、法線は y 方向
  const grab = vec3(2000, 0, 1000);
  const plane = { origin: grab, normal: vec3(0, 1, 0) };
  const ray: Ray3 = { origin: vec3(2500, 3000, 1200), direction: normalize3(vec3(-0.2, -1, -0.1)) };
  const at = rayPlane(ray, plane);
  assert.ok(at);
  assert.ok(Math.abs(at.y) < 1e-9, '壁の面から外れた');
});

test('鉛直線上の高さが取れる', () => {
  // 壁の天端を上下に動かすときに使う
  const eye = vec3(5000, 5000, 3000);
  const ray: Ray3 = { origin: eye, direction: normalize3(vec3(-5000, -5000, -2500)) };
  const z = rayVerticalAt(ray, vec3(0, 0, 0), eye);
  assert.ok(z !== null);
  assert.ok(Math.abs(z - 500) < 1e-6, `高さが ${z}`);
});

test('真上から見下ろすと鉛直線が点に潰れるので解を返さない', () => {
  const eye = vec3(0, 0, 9000);
  const ray: Ray3 = { origin: eye, direction: vec3(0, 0, -1) };
  assert.equal(rayVerticalAt(ray, vec3(0, 0, 0), eye), null);
});

test('鉛直の軸に沿ってカーソルを動かすと、高さがぴたりと追従する', () => {
  // **壁の天端を引き上げるときの手触り。**
  //
  // 鉛直線は画面の上では**傾いた線**に写る（透視なので真上ではない）ので、
  // 追従するのはその線に沿った動き。画面の真下へ引いた動きまで一致させることは
  // そもそもできない——カーソルが線から外れている以上、そこに乗る高さは無い。
  const cam = perspective();
  const axisAt = vec3(4000, 0, 0);
  const eye = cameraBasis(cam).eye;

  const s0 = toScreen(cam, vec3(4000, 0, 2400))!;
  const s1 = toScreen(cam, vec3(4000, 0, 3400))!;
  const len = Math.hypot(s1.x - s0.x, s1.y - s0.y);
  const dir = { x: (s1.x - s0.x) / len, y: (s1.y - s0.y) / len };
  assert.ok(Math.abs(dir.x) > 0.01, '前提: 投影された軸は画面上で傾いている');

  for (const k of [20, 70, 150, -40]) {
    const cx = s0.x + dir.x * k;
    const cy = s0.y + dir.y * k;
    const z = rayVerticalAt(screenRay(cam, cx, cy, W, H), axisAt, eye);
    assert.ok(z !== null, `${k}px で解が無い`);
    const back = toScreen(cam, vec3(4000, 0, z))!;
    const off = Math.hypot(back.x - cx, back.y - cy);
    assert.ok(off < 1e-6, `${k}px でカーソルから ${off.toFixed(4)}px ずれた`);
  }
});

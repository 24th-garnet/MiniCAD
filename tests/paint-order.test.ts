import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMesh, type Face3 } from '../src/render3d/mesh.ts';
import { paint } from '../src/render3d/paint.ts';
import { pickRay, screenRay } from '../src/render3d/ray.ts';
import { cameraBasis, defaultCamera, frameAll, projectPoint, viewProjection } from '../src/render3d/camera.ts';
import { buildBsp, bspOrder, bspSize } from '../src/render3d/bsp.ts';
import type { Vec3 } from '../src/render3d/mat4.ts';
import { sampleScene } from '../src/io/sample.ts';
import { sceneBounds } from '../src/core/entity.ts';
import { activeLevel } from '../src/core/level.ts';
import { detectRooms } from '../src/core/rooms.ts';

/**
 * **塗られた面と、本当に手前にある面を、画素ごとに突き合わせる。**
 *
 * MiniCAD の 3D は「塗るのはペインターズ法、拾うのは本物の深さ」という
 * 二枚看板で、`paint` と `pickRay` は別の経路で答えを出す。
 * **2 つが食い違う画素は、目に見える嘘そのもの。**
 *
 * これを測れるようにしたのは、`BUCKET_ORDER` が「家具を壁より後に塗る」
 * ことで、**家具が壁を透かして手前に出ていた**のを見つけたため。
 * 既定のカメラで画素の 9.5% が食い違っていた。
 */

const W = 120;
const H = 90;

/** 塗りの順に多角形を集める ctx。`paint` は多角形の fill しか頼まない */
function recordingContext(out: { pts: { x: number; y: number }[] }[]): CanvasRenderingContext2D {
  let current: { x: number; y: number }[] = [];
  return {
    save() {}, restore() {}, closePath() {}, stroke() {}, fillRect() {}, setLineDash() {},
    beginPath() { current = []; },
    moveTo(x: number, y: number) { current.push({ x, y }); },
    lineTo(x: number, y: number) { current.push({ x, y }); },
    fill() { if (current.length >= 3) out.push({ pts: current }); },
    fillStyle: '', strokeStyle: '', lineWidth: 0, lineJoin: '', lineCap: '', globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
}

const inPolygon = (x: number, y: number, pts: { x: number; y: number }[]): boolean => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

/** 画面に落とした多角形から、どの面かを逆引きするための鍵 */
const keyOf = (pts: { x: number; y: number }[]): string =>
  pts.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`).join(' ');

/**
 * 同じ深さとみなす幅 (mm)。
 *
 * 面と面が接している（床と壁、段と段）ところでは、画素の中心がどちらに
 * 乗るかで答えが入れ替わる。作図の最小の刻みは 1mm なので、それより
 * 細かい食い違いは見ない。
 */
const DEPTH_TOLERANCE = 1;

/** レイと、その面が乗る平面との交点までの距離。平行なら null */
function planeDistance(ray: { origin: Vec3; direction: Vec3 }, face: Face3): number | null {
  const n = face.normal;
  const denom = n.x * ray.direction.x + n.y * ray.direction.y + n.z * ray.direction.z;
  if (Math.abs(denom) < 1e-12) return null;
  const p0 = face.points[0];
  const num = n.x * (p0.x - ray.origin.x) + n.y * (p0.y - ray.origin.y) + n.z * (p0.z - ray.origin.z);
  return num / denom;
}

/** 塗られた面と本当に手前の面が食い違う画素の割合（%）と、内訳 */
function disagreement(pitch: number): { percent: number; worst: string } {
  const scene = sampleScene();
  const mesh = buildMesh(scene, detectRooms(scene));
  const cam = defaultCamera();
  frameAll(cam, sceneBounds(scene), activeLevel(scene).wallHeight);
  cam.pitch = pitch;

  // **塗るのは BSP が並べた断片。** 元の面と区別が要るのはここだけで、
  // 断片は `origin` で元を指している
  const ordered = bspOrder(buildBsp(mesh), cameraBasis(cam).eye);

  // 面 → 画面上の多角形の鍵。塗られた多角形から面を引くのに使う
  const view = viewProjection(cam, W, H);
  const byKey = new Map<string, Face3>();
  for (const face of ordered) {
    const pts = face.points.map((p) => projectPoint(view, p, W, H));
    if (pts.some((p) => p === null)) continue;
    byKey.set(keyOf(pts as { x: number; y: number }[]), face);
  }

  const polys: { pts: { x: number; y: number }[] }[] = [];
  paint(recordingContext(polys), cam, ordered, W, H, { dpr: 1, presorted: true });

  // 塗った順に上書き＝ペインターズ法の結果
  const painted: (Face3 | null)[] = new Array(W * H).fill(null);
  for (const poly of polys) {
    const face = byKey.get(keyOf(poly.pts));
    if (!face) continue;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (inPolygon(x + 0.5, y + 0.5, poly.pts)) painted[y * W + x] = face;
      }
    }
  }

  let seen = 0;
  let wrong = 0;
  const pairs = new Map<string, number>();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ray = screenRay(cam, x + 0.5, y + 0.5, W, H);
      const hit = pickRay(ray, mesh, view.near);
      const shown = painted[y * W + x];
      if (!hit || !shown) continue;
      seen += 1;
      // **深さで突き合わせる。** 面の同一性では見ない——BSP は面を割るので
      // 断片と元を取り違えうるし、同じ形の面が 2 枚あると逆引きが効かない。
      // **「その画素に塗られているものが、本当に手前にあるものと同じ深さか」**
      // が、見える嘘そのもの
      const t = planeDistance(ray, shown);
      if (t !== null && Math.abs(t - hit.t) <= DEPTH_TOLERANCE) continue;
      wrong += 1;
      const source = shown.origin ?? shown;
      const k = `塗=${source.bucket} 真=${hit.face.bucket}`;
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
  }
  const worst = [...pairs.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    percent: seen === 0 ? 0 : (wrong / seen) * 100,
    worst: worst ? `${worst[0]} が ${worst[1]} 画素` : 'なし',
  };
}

test('塗った面と、本当に手前の面が、どの画素でも一致する', () => {
  // **ここまでの経過**（下の 2 行はこの深さでの突き合わせで測り直した値）。
  //
  // | | 既定のカメラ | 真横寄り |
  // |---|---|---|
  // | `BUCKET_ORDER` の固定順だった頃（面の同一性で突き合わせた値） | 19.1% | 20% 超 |
  // | 壁・家具・ガラスを同じ順位にして深さ順にした | 0.86% | 1.00% |
  // | **面を割る木（BSP）で並べた** | **0.00%** | **0.00%** |
  //
  // 残っていた 1% は「壁どうしが互いに跨ぐ」古典的な重心ソートの破れで、
  // 重心は面を 1 点に潰すので**跨いだ組では必ずどちらかが嘘になる**。
  // 面を割れば跨いだ組そのものが無くなる。
  for (const pitch of [0.5, 0.12]) {
    const { percent, worst } = disagreement(pitch);
    assert.ok(percent < 0.2, `pitch=${pitch}: ${percent.toFixed(2)}% が食い違う（${worst}）`);
  }
});

test('面を割っても増えすぎない', () => {
  // 割った枚数は塗りの手間に直に効く。**建築の面は軸に揃っているので割れ目は少ない**
  // （サンプル間取りで 260 → 350 枚）。ここが跳ねたら、割る平面の選び方を疑う
  const scene = sampleScene();
  const mesh = buildMesh(scene, detectRooms(scene));
  const size = bspSize(buildBsp(mesh));
  assert.ok(size < mesh.length * 2, `${mesh.length} 枚が ${size} 枚になった`);
});

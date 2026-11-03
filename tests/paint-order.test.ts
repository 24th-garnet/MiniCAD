import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMesh, type Face3 } from '../src/render3d/mesh.ts';
import { paint } from '../src/render3d/paint.ts';
import { pickRay, screenRay } from '../src/render3d/ray.ts';
import { defaultCamera, frameAll, projectPoint, viewProjection } from '../src/render3d/camera.ts';
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
  pts.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(' ');

/** 塗られた面と本当に手前の面が食い違う画素の割合（%）と、内訳 */
function disagreement(pitch: number): { percent: number; worst: string } {
  const scene = sampleScene();
  const mesh = buildMesh(scene, detectRooms(scene));
  const cam = defaultCamera();
  frameAll(cam, sceneBounds(scene), activeLevel(scene).wallHeight);
  cam.pitch = pitch;

  // 面 → 画面上の多角形の鍵。塗られた多角形から面を引くのに使う
  const view = viewProjection(cam, W, H);
  const byKey = new Map<string, Face3>();
  for (const face of mesh) {
    const pts = face.points.map((p) => projectPoint(view, p, W, H));
    if (pts.some((p) => p === null)) continue;
    byKey.set(keyOf(pts as { x: number; y: number }[]), face);
  }

  const polys: { pts: { x: number; y: number }[] }[] = [];
  paint(recordingContext(polys), cam, mesh, W, H, { dpr: 1 });

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
      const hit = pickRay(screenRay(cam, x + 0.5, y + 0.5, W, H), mesh, view.near);
      const shown = painted[y * W + x];
      if (!hit || !shown) continue;
      seen += 1;
      if (hit.face === shown) continue;
      // 同じ場所・同じ向きの別インスタンスは「嘘」ではない
      if (hit.face.bucket === shown.bucket && hit.face.ref?.id === shown.ref?.id) continue;
      wrong += 1;
      const k = `塗=${shown.bucket} 真=${hit.face.bucket}`;
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
  }
  const worst = [...pairs.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    percent: seen === 0 ? 0 : (wrong / seen) * 100,
    worst: worst ? `${worst[0]} が ${worst[1]} 画素` : 'なし',
  };
}

test('塗った面と、本当に手前の面が、ほとんどの画素で一致する', () => {
  // **直す前は 19.1%（既定）/ 20% 超（真横寄り）だった。**
  // 筆頭は「家具が壁を透かす」で、原因は深度ソートではなく順位の固定。
  // 壁・家具・ガラスを同じ順位にして深さで並べたら 1.0% / 1.7% になった。
  //
  // **残りを 0 にするには面を分割する木（BSP）が要る。** どれも
  // 「壁どうしが互いに跨ぐ」古典的な重心ソートの破れで、BSP を入れる段で
  // この数字がさらに下がる（下がらなければ入れた意味が無い）
  for (const pitch of [0.5, 0.12]) {
    const { percent, worst } = disagreement(pitch);
    assert.ok(percent < 3, `pitch=${pitch}: ${percent.toFixed(1)}% が食い違う（${worst}）`);
  }
});

import { transformPoint, type Vec3 } from './mat4.ts';
import { lambert, shade } from './shading.ts';
import { BUCKET_ORDER, type Face3 } from './mesh.ts';
import { viewProjection, type Camera3D } from './camera.ts';
import { theme } from '../render/theme.ts';

/**
 * 面を奥から手前へ塗る（ペインターズ法）。
 *
 * Canvas 2D では深度バッファを書けない（`getImageData` 経由は 1920×1080 で
 * 毎フレーム 200 万回の JS ループになり 60fps は不可能）。
 *
 * 交差による破綻は、形を作る時点で避けている:
 * 床は**内法**ポリゴンなので壁と面で接するだけで食い込まず、
 * 床 → 壁 → 家具 → ガラス の固定順で塗れば層をまたぐ破綻は起きない。
 * 深度ソートは各層の内側だけで行う。
 *
 * **`ctx` には多角形の fill と stroke しか頼まない。**
 * `clip` / `setTransform` / `scale` / グラデーションは使わない（テストの
 * Canvas スタブに無く、使うとテストが 3D のバグを捕まえられなくなる）。
 * 画面の倍率 (DPR) も `setTransform` ではなく座標に直接掛ける。
 */

export interface PaintOptions {
  /** 面の上から稜線を重ねる（デバッグ用） */
  showEdges?: boolean;
  /** 画面の倍率。座標に直接掛ける */
  dpr?: number;
}

interface DrawFace {
  /** 画面のピクセル座標 */
  points: { x: number; y: number }[];
  /** カメラ空間 z の重心。奥ほど小さい */
  depth: number;
  bucket: number;
  color: string;
}

export function paint(
  ctx: CanvasRenderingContext2D,
  cam: Camera3D,
  mesh: Face3[],
  width: number,
  height: number,
  options: PaintOptions = {},
): void {
  const dpr = options.dpr ?? 1;
  ctx.setLineDash([]);
  ctx.fillStyle = theme.sky3d;
  ctx.fillRect(0, 0, width * dpr, height * dpr);
  if (width <= 0 || height <= 0) return;

  const view = viewProjection(cam, width, height);
  const faces: DrawFace[] = [];

  for (const face of mesh) {
    if (!face.doubleSided && isBackFacing(face, view.eye, view.forward, cam.mode)) continue;

    // カメラ空間へ。ここで near より手前を切る。やらないと w ≈ 0 で座標が ±∞ に飛ぶ
    const camPts = face.points.map((p) => transformPoint(view.view, p));
    const clipped = clipNear(camPts, view.near);
    if (clipped.length < 3) continue;

    const points: { x: number; y: number }[] = [];
    let depth = 0;
    let ok = true;
    for (const c of clipped) {
      const p = transformPoint(view.projection, { x: c.x, y: c.y, z: c.z });
      if (!(Math.abs(p.w) > 1e-9)) {
        ok = false;
        break;
      }
      const x = ((p.x / p.w) * 0.5 + 0.5) * width * dpr;
      const y = (0.5 - (p.y / p.w) * 0.5) * height * dpr;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        ok = false;
        break;
      }
      points.push({ x, y });
      depth += c.z;
    }
    if (!ok || points.length < 3) continue;

    faces.push({
      points,
      depth: depth / clipped.length,
      bucket: BUCKET_ORDER.indexOf(face.bucket),
      color: shade(face.color, lambert(face.normal)),
    });
  }

  // 層の順が主キー。同じ層の中だけ、カメラ空間 z の小さい（奥の）ものから塗る
  faces.sort((a, b) => a.bucket - b.bucket || a.depth - b.depth);

  for (const f of faces) {
    ctx.beginPath();
    ctx.moveTo(f.points[0].x, f.points[0].y);
    for (let i = 1; i < f.points.length; i++) ctx.lineTo(f.points[i].x, f.points[i].y);
    ctx.closePath();
    ctx.fillStyle = f.color;
    ctx.fill();
    if (options.showEdges) {
      ctx.strokeStyle = theme.edge3d;
      ctx.lineWidth = dpr;
      ctx.stroke();
    }
  }
}

/**
 * 背面か。**ワールド空間の法線**で判定する。
 * 画面の巻き方向で判定すると y 下向きの符号で間違えやすいので、こちらのほうが安全。
 */
function isBackFacing(face: Face3, eye: Vec3, forward: Vec3, mode: Camera3D['mode']): boolean {
  if (mode === 'ortho') return face.normal.x * forward.x + face.normal.y * forward.y + face.normal.z * forward.z > 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of face.points) {
    cx += p.x;
    cy += p.y;
    cz += p.z;
  }
  const n = face.points.length;
  const dx = cx / n - eye.x;
  const dy = cy / n - eye.y;
  const dz = cz / n - eye.z;
  return face.normal.x * dx + face.normal.y * dy + face.normal.z * dz > 0;
}

interface CamPoint {
  x: number;
  y: number;
  z: number;
}

/** near 平面（z = −near）より奥だけを残す。Sutherland–Hodgman の1平面版 */
function clipNear(points: { x: number; y: number; z: number }[], near: number): CamPoint[] {
  const limit = -near;
  const out: CamPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const aIn = a.z <= limit;
    const bIn = b.z <= limit;
    if (aIn) out.push({ x: a.x, y: a.y, z: a.z });
    if (aIn !== bIn) {
      const t = (limit - a.z) / (b.z - a.z);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: limit });
    }
  }
  return out;
}

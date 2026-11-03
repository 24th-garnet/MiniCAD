import { transformPoint, type Vec3 } from './mat4.ts';
import { lambert, shade } from './shading.ts';
import { BUCKET_RANK, type Face3 } from './mesh.ts';
import { viewProjection, type Camera3D } from './camera.ts';
import { theme } from '../render/theme.ts';
import type { EntityRef } from '../core/types.ts';

/**
 * 面を奥から手前へ塗る（ペインターズ法）。
 *
 * Canvas 2D では深度バッファを書けない（`getImageData` 経由は 1920×1080 で
 * 毎フレーム 200 万回の JS ループになり 60fps は不可能）。
 *
 * 交差による破綻は、形を作る時点で避けている:
 * 床は**内法**ポリゴンなので壁と面で接するだけで食い込まない。
 *
 * **塗る順は「床が先、あとは深さ順」**（`BUCKET_RANK`）。
 * 以前は 床 → 壁 → 家具 → ガラス の固定順で、家具とガラスが壁より必ず後に
 * 塗られていた。壁の向こうにあるものが**壁を透かして手前に出る**ので、
 * サンプル間取りで画素の約 2 割が「塗られた色」と「本当に手前の面」で
 * 食い違っていた（`tests/paint-order.test.ts`）。
 *
 * **`ctx` には多角形の fill と stroke しか頼まない。**
 * `clip` / `setTransform` / `scale` / グラデーションは使わない（テストの
 * Canvas スタブに無く、使うとテストが 3D のバグを捕まえられなくなる）。
 * 画面の倍率 (DPR) も `setTransform` ではなく座標に直接掛ける。
 * 強調表示（`PaintOptions.tint`）も**色の文字列を差し替えるだけ**なので、
 * この約束は変わらない。
 *
 * **塗るのはペインターズ法、拾うのは本物の深さ**（`ray.ts`）。2 つの深度規則が
 * 並ぶが食い違わないのは、床を内法で作って壁と交差させていないから。
 */

export interface PaintOptions {
  /** 面の上から稜線を重ねる（デバッグ用） */
  showEdges?: boolean;
  /** 画面の倍率。座標に直接掛ける */
  dpr?: number;
  /**
   * 面の色の差し替え。null を返せば元の色のまま。
   *
   * **色の文字列を返すだけ**にしてある。`ctx` に頼むことは変わらないので、
   * 「多角形の fill と stroke しか使わない」という上の約束は生きたまま。
   */
  tint?: (ref: EntityRef | null) => string | null;
  /**
   * 空で塗りつぶしてから描くか。**重ねるときだけ false。**
   *
   * 作図の補助（作図面の格子・置こうとしている立体の仮の姿）は、
   * 図面の面と**同じ列に混ぜない**。重心の深さで並べる方式では、
   * 大きい壁の面の重心が、その壁に貼った小さい格子より手前に来ることがあり、
   * **壁に敷いた格子が壁に隠れる**（実際にそうなって見つけた）。
   * 補助は図面ではないので、2 回目の塗りで上に重ねるほうが正しい。
   */
  clear?: boolean;
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
  if (options.clear !== false) {
    ctx.fillStyle = theme.sky3d;
    ctx.fillRect(0, 0, width * dpr, height * dpr);
  }
  if (width <= 0 || height <= 0) return;

  const view = viewProjection(cam, width, height);
  const faces: DrawFace[] = [];

  const tint = options.tint;

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
      bucket: BUCKET_RANK[face.bucket],
      color: shade(tint?.(face.ref) ?? face.color, lambert(face.normal)),
    });
  }

  // 順位が主キー。**同じ順位のものは深さだけで並ぶ**（壁と家具が同じ順位）
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

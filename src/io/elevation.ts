import { wallHeightOf } from '../core/level.ts';
import { openingVertical } from '../core/opening.ts';
import { wallSpans } from '../core/shape.ts';
import { OPENING_SYMBOLS } from '../core/opening.ts';
import type { Scene, Wall } from '../core/types.ts';

/**
 * 壁 1 枚の立面図を SVG で起こす。
 *
 * **新しい幾何を書かない。** 3D の押し出し（`src/render3d/mesh.ts` の `extrudeWall`）が
 * 既に `(lo, hi, sill, head)` の 4 つ組で開口の矩形を決めている。立面はそれを
 * 高さ方向に潰しただけで、必要な数は全部揃っている。
 *
 * | 要る数 | 出どころ |
 * |---|---|
 * | 壁の長さ・開口を抜いた区間 | `wallSpans(scene, wall)` |
 * | 壁の上下端 | `level.floorZ` と `wallHeightOf(wall, level)` |
 * | 開口の壁上の位置 | `WallHole.lo / hi` |
 * | 開口の上下端 | `openingVertical(opening, level)` |
 *
 * **建具の割付は描かない。** 引違いの召し合わせも、開き勝手も、サッシの framing も
 * 寸法として持っていない。外形と開口の矩形までを出して、**持っていないものは
 * 描かずに但し書きにする**（平面図が「開き勝手は未計測」と書くのと同じ）。
 */

export interface ElevationOptions {
  /** 用紙に対する尺度。1:50 なら 50 */
  scale: number;
  /** 寸法線を入れるか */
  dimensions: boolean;
}

export const DISCLAIMER = '建具の割付（召し合わせ・サッシ・開き勝手）は未計測です';

/** 立面 1 枚ぶんの図形。SVG にも DXF にも落とせる中間の形 */
export interface Elevation {
  wallId: string;
  /** 壁の見付長さ (mm) */
  length: number;
  /** 壁の高さ (mm) */
  height: number;
  /** 壁の実体が残っている区間（床から天井まで） */
  solid: { lo: number; hi: number }[];
  /** 開口の矩形。`sill` と `head` は床からの高さ */
  openings: { id: string; kind: string; label: string;
              lo: number; hi: number; sill: number; head: number }[];
}

/** 壁 1 枚の立面を組む。壁が無ければ null */
export function elevationOf(scene: Scene, wall: Wall): Elevation | null {
  const ws = wallSpans(scene, wall);
  if (!ws) return null;
  const level = scene.level;
  const height = wallHeightOf(wall, level);

  const openings = ws.holes.map((hole) => {
    const v = openingVertical(hole.opening, level);
    const sill = Math.max(0, Math.min(v.sill - level.floorZ, height));
    const head = Math.max(0, Math.min(v.head - level.floorZ, height));
    return {
      id: hole.opening.id,
      kind: hole.opening.kind as string,
      label: OPENING_SYMBOLS[hole.opening.kind].label,
      lo: hole.lo, hi: hole.hi, sill, head,
    };
  });

  return {
    wallId: wall.id,
    length: ws.total,
    height,
    solid: ws.spans.map(([lo, hi]) => ({ lo, hi })),
    openings,
  };
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/**
 * 立面を SVG にする。
 *
 * 座標は **mm をそのまま使い、Y を反転する**（床が下、天井が上）。紙の上の尺度は
 * 見る側が決めるので、ここでは実寸で出す——平面図の SVG と同じ流儀。
 */
export function elevationToSvg(
  elevations: Elevation[],
  options: ElevationOptions = { scale: 50, dimensions: true },
): string {
  const GAP = 800;        // 立面どうしの間（mm）
  const PAD = 600;        // 余白。寸法線を置く場所でもある
  const width = Math.max(...elevations.map((e) => e.length), 1000);
  const total = elevations.reduce((sum, e) => sum + e.height + GAP, 0) - GAP;

  const parts: string[] = [];
  let y = PAD;
  for (const e of elevations) {
    const base = y + e.height;      // 床の高さ（SVG の下向き座標）
    parts.push(`<g data-wall="${esc(e.wallId)}">`);

    // 壁の外形。開口に食われていない区間だけを塗る
    for (const s of e.solid) {
      parts.push(`<rect class="wall" x="${PAD + s.lo}" y="${y}"`
        + ` width="${s.hi - s.lo}" height="${e.height}"/>`);
    }
    // 腰壁とまぐさ。開口の上下に残る壁
    for (const o of e.openings) {
      const w = o.hi - o.lo;
      if (o.sill > 0) {
        parts.push(`<rect class="wall" x="${PAD + o.lo}" y="${base - o.sill}"`
          + ` width="${w}" height="${o.sill}"/>`);
      }
      if (o.head < e.height) {
        parts.push(`<rect class="wall" x="${PAD + o.lo}" y="${y}"`
          + ` width="${w}" height="${e.height - o.head}"/>`);
      }
      // 開口そのもの
      parts.push(`<rect class="opening" x="${PAD + o.lo}" y="${base - o.head}"`
        + ` width="${w}" height="${o.head - o.sill}"/>`);
      parts.push(`<text class="label" x="${PAD + o.lo + w / 2}"`
        + ` y="${base - (o.sill + o.head) / 2}">${esc(o.label)}</text>`);
    }
    // 床線と天井線
    parts.push(`<line class="floor" x1="${PAD - 200}" y1="${base}"`
      + ` x2="${PAD + e.length + 200}" y2="${base}"/>`);

    if (options.dimensions) {
      // **高さ方向の寸法。** 平面図の寸法はすべて水平方向なので、ここが初めて
      const x = PAD - 300;
      parts.push(`<line class="dim" x1="${x}" y1="${y}" x2="${x}" y2="${base}"/>`);
      parts.push(`<text class="dim-text" x="${x - 60}" y="${y + e.height / 2}"`
        + ` transform="rotate(-90 ${x - 60} ${y + e.height / 2})">${e.height}</text>`);
      for (const o of e.openings) {
        const ox = PAD + o.hi + 120;
        parts.push(`<line class="dim" x1="${ox}" y1="${base - o.head}"`
          + ` x2="${ox}" y2="${base - o.sill}"/>`);
        parts.push(`<text class="dim-text" x="${ox + 60}"`
          + ` y="${base - (o.sill + o.head) / 2}">${o.head - o.sill}</text>`);
      }
    }
    parts.push('</g>');
    y += e.height + GAP;
  }

  const w = width + PAD * 2;
  const h = total + PAD * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"
  width="${w / options.scale}mm" height="${h / options.scale}mm">
<style>
  .wall { fill: #e8e8e8; stroke: #111; stroke-width: 24; }
  .opening { fill: #fff; stroke: #111; stroke-width: 12; }
  .floor { stroke: #111; stroke-width: 36; }
  .dim { stroke: #555; stroke-width: 8; }
  .label { font: 140px sans-serif; text-anchor: middle; dominant-baseline: middle; fill: #555; }
  .dim-text { font: 140px sans-serif; text-anchor: middle; fill: #555; }
</style>
${parts.join('\n')}
<text class="dim-text" x="${PAD}" y="${h - 160}" text-anchor="start">${esc(DISCLAIMER)}</text>
</svg>`;
}

/** シーン全体から、開口のある壁の立面を順に組む */
export function sceneToElevations(scene: Scene): Elevation[] {
  return Object.values(scene.walls)
    .map((w) => elevationOf(scene, w))
    .filter((e): e is Elevation => e !== null && e.openings.length > 0);
}

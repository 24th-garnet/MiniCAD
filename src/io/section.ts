import { levelOf, wallHeightOf } from '../core/level.ts';
import { openingVertical, OPENING_SYMBOLS } from '../core/opening.ts';
import { openingsOnWall } from '../core/ops.ts';
import { wallEnds } from '../core/ops.ts';
import { dist, sub, norm, dot, type Vec } from '../core/geometry.ts';
import type { Scene } from '../core/types.ts';

/**
 * 断面図。**切断線を横切る壁を、切り口として出す。**
 *
 * 立面図が「壁 1 枚を正面から見たもの」なのに対し、断面は「線で切って
 * 横から見たもの」。難しいところ（開口の `(lo, hi, sill, head)` 4 つ組）は
 * 立面図と同じ出どころから来るので、新しい幾何は書かない。
 *
 * ## 切った先は描かない
 *
 * 本来の断面図は、切り口の向こうに見えるもの（奥の壁・建具・家具）も
 * 描く。MiniCAD は**切り口だけ**を出す。奥行きの重なりを正しく出すには
 * 3D の隠線消去が要り、それはペインターズ法では書けない（`render3d/paint.ts`
 * の冒頭に理由がある）。
 *
 * **持っていないものは、持っていないと書く。** 図の下に但し書きを入れる。
 */

export const SECTION_DISCLAIMER =
  '切り口だけを描いています。切断線の先に見えるもの（奥の壁・建具・家具）は描いていません';

/** 切断線が壁を横切ったところ 1 つ */
export interface SectionCut {
  wallId: string;
  /** 切断線の始点からの距離 (mm) */
  along: number;
  /** 壁厚 (mm)。切り口の幅になる */
  thickness: number;
  /** 床からの下端と上端 (mm) */
  base: number;
  top: number;
  /** その位置に開口があれば、その上下端（床から） */
  opening: { id: string; label: string; sill: number; head: number } | null;
}

export interface Section {
  /** 切断線の長さ (mm) */
  length: number;
  /** 階高 (mm)。床線と天井線を引く高さ */
  levelHeight: number;
  cuts: SectionCut[];
}

/**
 * 切断線 `a → b` で切る。
 *
 * 壁の芯線との交点を取り、その位置に開口が掛かっていれば上下端も拾う。
 * **床に着かない壁（垂れ壁）も出る** —— 断面はまさにそれを見るための図。
 */
export function sectionAlong(scene: Scene, a: Vec, b: Vec): Section | null {
  const total = dist(a, b);
  if (total < 1) return null;
  const dir = norm(sub(b, a));
  const cuts: SectionCut[] = [];

  for (const wall of Object.values(scene.walls)) {
    const [wa, wb] = wallEnds(scene, wall);
    const hit = segmentIntersection(a, b, wa, wb);
    if (!hit) continue;
    const level = levelOf(scene, wall.levelId);
    const along = dot(sub(hit, a), dir);
    if (along < 0 || along > total) continue;

    // 壁の始点からの距離。開口が掛かっているかはこれで決まる
    const onWall = dist(wa, hit);
    let opening: SectionCut['opening'] = null;
    for (const o of openingsOnWall(scene, wall.id)) {
      if (onWall < o.offset - o.width / 2 || onWall > o.offset + o.width / 2) continue;
      const v = openingVertical(o, level);
      opening = {
        id: o.id,
        label: OPENING_SYMBOLS[o.kind].label,
        sill: v.sill - level.floorZ,
        head: v.head - level.floorZ,
      };
      break;
    }

    cuts.push({
      wallId: wall.id,
      along,
      thickness: wall.thickness,
      base: wall.base,
      top: wall.base + wallHeightOf(wall, level),
      opening,
    });
  }

  if (cuts.length === 0) return null;
  cuts.sort((x, y) => x.along - y.along);
  const levelHeight = Math.max(...cuts.map((c) => c.top), 1);
  return { length: total, levelHeight, cuts };
}

/** 線分どうしの交点。平行・交わらないなら null */
function segmentIntersection(p1: Vec, p2: Vec, p3: Vec, p4: Vec): Vec | null {
  const d1 = sub(p2, p1);
  const d2 = sub(p4, p3);
  const den = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(den) < 1e-9) return null;
  const s = ((p3.x - p1.x) * d2.y - (p3.y - p1.y) * d2.x) / den;
  const t = ((p3.x - p1.x) * d1.y - (p3.y - p1.y) * d1.x) / den;
  if (s < 0 || s > 1 || t < 0 || t > 1) return null;
  return { x: p1.x + d1.x * s, y: p1.y + d1.y * s };
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** 断面を SVG にする。立面図と同じ流儀で、mm を実寸のまま使い Y を反転する */
export function sectionToSvg(section: Section, scale = 50): string {
  const PAD = 800;
  const h = section.levelHeight;
  const base = PAD + h;      // 床の高さ（SVG の下向き座標）
  const parts: string[] = [];

  // 床線と天井線。**切り口の位置関係が読めるようにするための下地**
  parts.push(`<line class="floor" x1="${PAD - 300}" y1="${base}" x2="${PAD + section.length + 300}" y2="${base}"/>`);
  parts.push(`<line class="ceiling" x1="${PAD - 300}" y1="${PAD}" x2="${PAD + section.length + 300}" y2="${PAD}"/>`);

  for (const c of section.cuts) {
    const x = PAD + c.along - c.thickness / 2;
    const g: string[] = [`<g data-wall="${esc(c.wallId)}">`];
    const top = base - c.top;
    const bottom = base - c.base;

    if (!c.opening) {
      g.push(`<rect class="cut" x="${x}" y="${top}" width="${c.thickness}" height="${bottom - top}"/>`);
    } else {
      // 腰壁とまぐさ。開口に食われた間は空ける
      const sill = base - Math.max(c.base, c.opening.sill);
      const head = base - Math.min(c.top, c.opening.head);
      if (bottom - sill > 1) g.push(`<rect class="cut" x="${x}" y="${sill}" width="${c.thickness}" height="${bottom - sill}"/>`);
      if (head - top > 1) g.push(`<rect class="cut" x="${x}" y="${top}" width="${c.thickness}" height="${head - top}"/>`);
      g.push(`<rect class="opening" x="${x}" y="${head}" width="${c.thickness}" height="${sill - head}"/>`);
      g.push(`<text class="label" x="${x + c.thickness / 2}" y="${(sill + head) / 2}"`
        + ` transform="rotate(-90 ${x + c.thickness / 2} ${(sill + head) / 2})">${esc(c.opening.label)}</text>`);
    }
    g.push('</g>');
    parts.push(...g);
  }

  // 階高の寸法
  const dx = PAD - 400;
  parts.push(`<line class="dim" x1="${dx}" y1="${PAD}" x2="${dx}" y2="${base}"/>`);
  parts.push(`<text class="dim-text" x="${dx - 80}" y="${PAD + h / 2}"`
    + ` transform="rotate(-90 ${dx - 80} ${PAD + h / 2})">${Math.round(h)}</text>`);

  const w = section.length + PAD * 2;
  const total = h + PAD * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${total}"
  width="${w / scale}mm" height="${total / scale}mm">
<style>
  .cut { fill: #9a9a9a; stroke: #111; stroke-width: 24; }
  .opening { fill: #fff; stroke: #111; stroke-width: 12; }
  .floor { stroke: #111; stroke-width: 40; }
  .ceiling { stroke: #555; stroke-width: 16; stroke-dasharray: 160 80; }
  .dim { stroke: #555; stroke-width: 8; }
  .label { font: 130px sans-serif; text-anchor: middle; dominant-baseline: middle; fill: #555; }
  .dim-text { font: 140px sans-serif; text-anchor: middle; fill: #555; }
</style>
${parts.join('\n')}
<text class="dim-text" x="${PAD}" y="${total - 160}" text-anchor="start">${esc(SECTION_DISCLAIMER)}</text>
</svg>`;
}

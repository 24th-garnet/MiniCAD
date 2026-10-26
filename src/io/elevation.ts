import { levelOf, wallHeightOf } from '../core/level.ts';
import { openingVertical } from '../core/opening.ts';
import { wallSpans } from '../core/shape.ts';
import { OPENING_SYMBOLS } from '../core/opening.ts';
import type { Room, Scene, Wall } from '../core/types.ts';

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
  const level = levelOf(scene, wall.levelId);
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
/** 立面 1 枚ぶんの図形。原点は左上。`elevationToSvg` と展開図が共有する */
function elevationParts(e: Elevation, ox: number, oy: number, dimensions: boolean): string[] {
  const parts: string[] = [];
  const base = oy + e.height; // 床の高さ（SVG の下向き座標）
  parts.push(`<g data-wall="${esc(e.wallId)}">`);

  // 壁の外形。開口に食われていない区間だけを塗る
  for (const s of e.solid) {
    parts.push(`<rect class="wall" x="${ox + s.lo}" y="${oy}"`
      + ` width="${s.hi - s.lo}" height="${e.height}"/>`);
  }
  // 腰壁とまぐさ。開口の上下に残る壁
  for (const o of e.openings) {
    const w = o.hi - o.lo;
    if (o.sill > 0) {
      parts.push(`<rect class="wall" x="${ox + o.lo}" y="${base - o.sill}"`
        + ` width="${w}" height="${o.sill}"/>`);
    }
    if (o.head < e.height) {
      parts.push(`<rect class="wall" x="${ox + o.lo}" y="${oy}"`
        + ` width="${w}" height="${e.height - o.head}"/>`);
    }
    // 開口そのもの
    parts.push(`<rect class="opening" x="${ox + o.lo}" y="${base - o.head}"`
      + ` width="${w}" height="${o.head - o.sill}"/>`);
    parts.push(`<text class="label" x="${ox + o.lo + w / 2}"`
      + ` y="${base - (o.sill + o.head) / 2}">${esc(o.label)}</text>`);
  }
  // 床線
  parts.push(`<line class="floor" x1="${ox - 200}" y1="${base}"`
    + ` x2="${ox + e.length + 200}" y2="${base}"/>`);

  if (dimensions) {
    // **高さ方向の寸法。** 平面図の寸法はすべて水平方向なので、ここが初めて
    const x = ox - 300;
    parts.push(`<line class="dim" x1="${x}" y1="${oy}" x2="${x}" y2="${base}"/>`);
    parts.push(`<text class="dim-text" x="${x - 60}" y="${oy + e.height / 2}"`
      + ` transform="rotate(-90 ${x - 60} ${oy + e.height / 2})">${e.height}</text>`);
    for (const o of e.openings) {
      const dx = ox + o.hi + 120;
      parts.push(`<line class="dim" x1="${dx}" y1="${base - o.head}"`
        + ` x2="${dx}" y2="${base - o.sill}"/>`);
      parts.push(`<text class="dim-text" x="${dx + 60}"`
        + ` y="${base - (o.sill + o.head) / 2}">${o.head - o.sill}</text>`);
    }
  }
  parts.push('</g>');
  return parts;
}

/** 立面図・展開図で共通の見た目 */
const ELEVATION_STYLE = `<style>
  .wall { fill: #e8e8e8; stroke: #111; stroke-width: 24; }
  .opening { fill: #fff; stroke: #111; stroke-width: 12; }
  .floor { stroke: #111; stroke-width: 36; }
  .dim { stroke: #555; stroke-width: 8; }
  .label { font: 140px sans-serif; text-anchor: middle; dominant-baseline: middle; fill: #555; }
  .dim-text { font: 140px sans-serif; text-anchor: middle; fill: #555; }
  .face { font: 180px sans-serif; fill: #111; }
  .room { font: 240px sans-serif; fill: #111; font-weight: bold; }
</style>`;

const GAP = 800;        // 立面どうしの間（mm）
const PAD = 600;        // 余白。寸法線を置く場所でもある

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
  const width = Math.max(...elevations.map((e) => e.length), 1000);
  const total = elevations.reduce((sum, e) => sum + e.height + GAP, 0) - GAP;

  const parts: string[] = [];
  let y = PAD;
  for (const e of elevations) {
    parts.push(...elevationParts(e, PAD, y, options.dimensions));
    y += e.height + GAP;
  }

  const w = width + PAD * 2;
  const h = total + PAD * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"
  width="${w / options.scale}mm" height="${h / options.scale}mm">
${ELEVATION_STYLE}
${parts.join('\n')}
<text class="dim-text" x="${PAD}" y="${h - 160}" text-anchor="start">${esc(DISCLAIMER)}</text>
</svg>`;
}

/**
 * 部屋の展開図。**部屋を内側から見た立面を、壁の並び順に並べる。**
 *
 * `Elevation` をそのまま使う。新しい幾何は書かない。
 *
 * **向きを揃えるのが仕事のほとんど。** `Elevation` は壁の始点 → 終点の向きで
 * 位置を持つが、部屋を一周する向きはその壁ごとに逆になりうる。揃えないと、
 * 展開図の 1 面だけ建具が左右逆の位置に出る。部屋の多角形は半辺の巡回から
 * 作られていて `wallIds[i]` がその半辺の壁なので、**巡回の向きと壁の向きが
 * 一致するか**を見れば決まる。
 *
 * 面の名前は A・B・C… 。方位（北・東）にしないのは、図面に方位が無いため
 * ——**持っていないものは、持っていないと書く**より、持っている順で呼ぶ。
 */
export interface RoomElevation {
  roomName: string;
  faces: { name: string; elevation: Elevation }[];
}

export function roomElevation(scene: Scene, room: Room): RoomElevation | null {
  const faces: { name: string; elevation: Elevation }[] = [];
  const seen = new Set<string>();

  room.wallIds.forEach((wallId, i) => {
    if (seen.has(wallId)) return;
    seen.add(wallId);
    const wall = scene.walls[wallId];
    if (!wall) return;
    const got = elevationOf(scene, wall);
    if (!got) return;
    // 巡回は polygon[i] から polygon[i+1] へ。壁の始点がそこに居れば向きが合う
    const from = room.polygon[i];
    const a = scene.nodes[wall.a];
    const forward = !a || !from || (Math.hypot(a.x - from.x, a.y - from.y) < 1);
    faces.push({
      name: String.fromCharCode(65 + faces.length),
      elevation: forward ? got : mirrorElevation(got),
    });
  });

  return faces.length === 0 ? null : { roomName: room.name ?? '(無名)', faces };
}

/** 左右を反転した立面。部屋の内側から見るための向き合わせ */
function mirrorElevation(e: Elevation): Elevation {
  const flip = (lo: number, hi: number) => ({ lo: e.length - hi, hi: e.length - lo });
  return {
    ...e,
    solid: e.solid.map((s) => flip(s.lo, s.hi)),
    openings: e.openings.map((o) => ({ ...o, ...flip(o.lo, o.hi) })),
  };
}

/** 部屋ごとの展開図。壁で閉じた部屋すべてぶん */
export function sceneToRoomElevations(scene: Scene, rooms: Room[]): RoomElevation[] {
  return rooms.map((r) => roomElevation(scene, r)).filter((v): v is RoomElevation => v !== null);
}

/**
 * 展開図を SVG にする。**1 枚の SVG に、部屋ごとに 1 列。**
 *
 * 各面に A・B・C… の見出しと、列の頭に部屋名を付ける。
 * 立面 1 枚の描き方は `elevationToSvg` と同じものを使う。
 */
export function roomElevationsToSvg(
  rooms: RoomElevation[],
  options: ElevationOptions = { scale: 50, dimensions: true },
): string {
  const parts: string[] = [];
  const TITLE = 500;      // 部屋名のぶんの高さ
  let y = PAD;
  let width = 1000;

  for (const room of rooms) {
    parts.push(`<text class="room" x="${PAD}" y="${y + 240}">${esc(room.roomName)}</text>`);
    y += TITLE;
    for (const face of room.faces) {
      const e = face.elevation;
      width = Math.max(width, e.length);
      parts.push(`<text class="face" x="${PAD}" y="${y - 80}">${esc(face.name)} 面</text>`);
      parts.push(...elevationParts(e, PAD, y, options.dimensions));
      y += e.height + GAP;
    }
  }

  const w = width + PAD * 2;
  const h = y + PAD;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"
  width="${w / options.scale}mm" height="${h / options.scale}mm">
${ELEVATION_STYLE}
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

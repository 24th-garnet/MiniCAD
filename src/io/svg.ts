import { add, angleOf, dist, mid, mul, norm, perp, sub, toDeg, vec, type Vec } from '../core/geometry.ts';
import { sceneBounds } from '../core/entity.ts';
import { getLayer, LAYER_IDS, layerDashWorld, layerWeight, type Layer } from '../core/layer.ts';
import { wallEnds } from '../core/ops.ts';
import { dimensionSide, toTatami } from '../core/rooms.ts';
import {
  doorSwing,
  furnitureLabelFits,
  furniturePolygon,
  openingFrame,
  openingQuad,
  wallOutline,
  wallQuad,
} from '../core/shape.ts';
import { paperToWorld } from '../core/standard.ts';
import type { Settings } from '../core/store.ts';
import type { Room, Scene } from '../core/types.ts';
import { FONT_FAMILY, theme } from '../render/theme.ts';

const MARGIN = 400; // mm

/**
 * 画面と同じ見た目の SVG を書き出す。
 *
 * 座標はワールドの mm のまま、線の太さと文字の高さは製図規格の「紙の上の mm」に
 * 尺度の分母を掛けて世界座標に直す（1:100 なら 0.5mm の線は 50mm 幅になる）。
 * こうしておくと、SVG を尺度どおりに印刷したとき線が JIS の太さになる。
 */
export function sceneToSvg(scene: Scene, rooms: Room[], settings: Settings): string {
  const std = scene.standard;
  const b = sceneBounds(scene);
  if (!b) return emptySvg();

  const minX = b.min.x - MARGIN;
  const minY = b.min.y - MARGIN;
  const width = b.max.x - b.min.x + MARGIN * 2;
  const height = b.max.y - b.min.y + MARGIN * 2;

  const layerOf = (id: string | undefined, fallback: string): Layer => getLayer(scene.layers, id, fallback);
  /** 画層の線の太さをワールドの mm に直す */
  const strokeWidth = (layer: Layer): number => paperToWorld(layerWeight(layer, std), std);
  const dashAttr = (layer: Layer): string => {
    const dash = layerDashWorld(layer, std);
    return dash.length === 0 ? '' : ` stroke-dasharray="${dash.map(round).join(' ')}"`;
  };
  const visible = (layer: Layer): boolean => layer.visible && layer.printable;

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width / std.scale)}mm" height="${round(height / std.scale)}mm" viewBox="0 0 ${round(width)} ${round(height)}">`,
  );
  out.push(`<!-- MiniCAD 1:${std.scale} / 線群 ${std.lineGroupId} / 単位 mm -->`);
  out.push(`<rect width="${round(width)}" height="${round(height)}" fill="${theme.paper}"/>`);
  // y 反転 + 原点合わせ
  out.push(`<g transform="translate(${round(-minX)} ${round(minY + height)}) scale(1 -1)">`);

  for (const room of rooms) {
    const poly = room.innerPolygon.length >= 3 ? room.innerPolygon : room.polygon;
    out.push(`<polygon points="${pointsAttr(poly)}" fill="#ffffff"/>`);
  }

  // --- 壁 ---
  for (const wall of Object.values(scene.walls)) {
    const layer = layerOf(wall.layerId, LAYER_IDS.wall);
    if (!visible(layer)) continue;
    // 塗らない設定でも、下の部屋塗りを隠すため紙の色で埋める
    out.push(`<polygon points="${pointsAttr(wallQuad(scene, wall))}" fill="${std.wallFill ? layer.color : theme.paper}"/>`);
  }
  for (const op of Object.values(scene.openings)) {
    const f = openingFrame(scene, op);
    if (!f) continue;
    out.push(`<polygon points="${pointsAttr(openingQuad(f))}" fill="${theme.paper}"/>`);
  }
  if (!std.wallFill) {
    for (const wall of Object.values(scene.walls)) {
      const layer = layerOf(wall.layerId, LAYER_IDS.wall);
      if (!visible(layer)) continue;
      for (const s of wallOutline(scene, wall)) {
        out.push(lineTag(s.a, s.b, layer.color, strokeWidth(layer), dashAttr(layer)));
      }
    }
  }

  // --- 建具 ---
  for (const op of Object.values(scene.openings)) {
    const layer = layerOf(op.layerId, LAYER_IDS.opening);
    if (!visible(layer)) continue;
    const f = openingFrame(scene, op);
    if (!f) continue;
    const w = strokeWidth(layer);
    const half = mul(f.normal, f.thickness / 2);
    for (const p of [f.start, f.end]) out.push(lineTag(add(p, half), sub(p, half), layer.color, w));

    if (op.kind === 'window') {
      for (const t of [-0.5, 0.5]) {
        const off = mul(f.normal, (f.thickness / 2) * t);
        out.push(lineTag(add(f.start, off), add(f.end, off), layer.color, w));
      }
    } else if (op.kind === 'door') {
      const swing = doorSwing(f, op.flipX, op.flipY);
      out.push(lineTag(swing.hinge, swing.open, layer.color, w));
      // SVG の弧は y 反転した座標系で描くので、掃く向きの指定も反転する
      const sweep = swing.ccwFromOpenToClosed ? 0 : 1;
      out.push(
        `<path d="M ${round(swing.open.x)} ${round(swing.open.y)} A ${round(swing.radius)} ${round(swing.radius)} 0 0 ${sweep} ${round(swing.closed.x)} ${round(swing.closed.y)}" fill="none" stroke="${layer.color}" stroke-width="${round(w)}" stroke-dasharray="${round(w * 6)} ${round(w * 4)}"/>`,
      );
    }
  }

  // --- 家具 ---
  for (const f of Object.values(scene.furniture)) {
    const layer = layerOf(f.layerId, LAYER_IDS.furniture);
    if (!visible(layer)) continue;
    const w = strokeWidth(layer);
    out.push(
      `<polygon points="${pointsAttr(furniturePolygon(f))}" fill="rgba(120,113,108,0.14)" stroke="${layer.color}" stroke-width="${round(w)}"/>`,
    );
    const nameSize = paperToWorld(std.textHeight.furniture, std);
    if (furnitureLabelFits(f.name, f, nameSize)) {
      out.push(textTag(f.name, vec(f.x, f.y), toDeg(f.angle), nameSize, theme.furnitureText));
    }
  }

  // --- 寸法 ---
  const dimLayer = layerOf(LAYER_IDS.dimension, LAYER_IDS.dimension);
  if (settings.showDimensions && visible(dimLayer)) {
    const size = paperToWorld(std.textHeight.dimension, std);
    for (const wall of Object.values(scene.walls)) {
      const [a, c] = wallEnds(scene, wall);
      const length = dist(a, c);
      if (length < size * 3) continue;
      const d = norm(sub(c, a));
      const n = perp(d);
      const center = mid(a, c);
      const side = dimensionSide(rooms, center, n, wall.thickness / 2 + 150);
      const at = add(center, mul(n, side * (wall.thickness / 2 + size)));
      out.push(textTag(`${Math.round(length)}`, at, toDeg(angleOf(d)), size, dimLayer.color));
    }
  }

  // --- 室名・面積 ---
  const nameLayer = layerOf(LAYER_IDS.roomName, LAYER_IDS.roomName);
  if (visible(nameLayer)) {
    const nameSize = paperToWorld(std.textHeight.room, std);
    const areaSize = paperToWorld(std.textHeight.area, std);
    for (const room of rooms) {
      const area = settings.innerArea ? room.innerArea : room.area;
      if (room.name) {
        out.push(textTag(room.name, add(room.center, vec(0, areaSize * 0.8)), 0, nameSize, nameLayer.color, 600));
      }
      out.push(
        textTag(
          `${area.toFixed(2)} m² (${toTatami(area).toFixed(1)}帖)`,
          add(room.center, vec(0, room.name ? -nameSize * 0.6 : 0)),
          0,
          areaSize,
          theme.roomArea,
        ),
      );
    }
  }

  out.push('</g></svg>');
  return out.join('\n');
}

function emptySvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 1000 1000"><rect width="1000" height="1000" fill="${theme.paper}"/></svg>`;
}

const round = (n: number): number => Math.round(n * 100) / 100;

const pointsAttr = (pts: Vec[]): string => pts.map((p) => `${round(p.x)},${round(p.y)}`).join(' ');

const lineTag = (a: Vec, b: Vec, stroke: string, width: number, extra = ''): string =>
  `<line x1="${round(a.x)}" y1="${round(a.y)}" x2="${round(b.x)}" y2="${round(b.y)}" stroke="${stroke}" stroke-width="${round(width)}"${extra}/>`;

/** y 反転した座標系なので、文字は個別に反転し直す */
function textTag(text: string, at: Vec, rotateDeg: number, size: number, fill: string, weight = 400): string {
  let angle = rotateDeg;
  while (angle > 90) angle -= 180;
  while (angle < -90) angle += 180;
  return (
    `<g transform="translate(${round(at.x)} ${round(at.y)}) scale(1 -1) rotate(${round(-angle)})">` +
    `<text x="0" y="0" font-family="${escapeXml(FONT_FAMILY)}" font-size="${round(size)}" font-weight="${weight}" fill="${fill}" text-anchor="middle" dominant-baseline="middle">${escapeXml(text)}</text></g>`
  );
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

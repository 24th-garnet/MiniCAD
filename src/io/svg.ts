import { add, toDeg, vec } from '../core/geometry.ts';
import { sceneBounds } from '../core/entity.ts';
import { paperDimensions, sheetPrimitives } from '../core/sheet.ts';
import {
  blockOf,
  instanceLabel,
  instancePrimitives,
  instanceSize,
  instanceVertices,
  labelFits,
} from '../core/block.ts';
import { getLayer, LAYER_IDS, layerDashWorld, layerWeight, type Layer } from '../core/layer.ts';
import { toTatami } from '../core/rooms.ts';
import { openingFrame, openingJambs, openingQuad, wallOutline, wallQuad } from '../core/shape.ts';
import { openingPrimitives } from '../core/opening.ts';
import { paperToWorld } from '../core/standard.ts';
import type { Settings } from '../core/store.ts';
import type { Room, Scene } from '../core/types.ts';
import { theme } from '../render/theme.ts';
import { lineTag, pointsAttr, round, svgPrimitives, textTag } from './svgPrimitive.ts';
import { shapePrimitives } from '../core/shapes.ts';

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
  const sheet = scene.sheet;
  const b = sceneBounds(scene);
  if (!b && !sheet.show) return emptySvg();

  // 用紙枠を出す設定なら、用紙そのものを書き出しの範囲にする。
  // こうすると尺度を変えても紙の実寸（A3 なら 420×297mm）が変わらない
  const paper = paperDimensions(std);
  const sheetGeo = sheet.show ? { minX: sheet.origin.x, minY: sheet.origin.y } : null;
  const minX = sheetGeo ? sheetGeo.minX : b!.min.x - MARGIN;
  const minY = sheetGeo ? sheetGeo.minY : b!.min.y - MARGIN;
  const width = sheetGeo ? paper.w * std.scale : b!.max.x - b!.min.x + MARGIN * 2;
  const height = sheetGeo ? paper.h * std.scale : b!.max.y - b!.min.y + MARGIN * 2;

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

  const sheetLayer = layerOf(LAYER_IDS.sheet, LAYER_IDS.sheet);
  if (sheet.show && visible(sheetLayer)) {
    out.push(...svgPrimitives(sheetPrimitives(sheet, std), sheetLayer, std));
  }

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
    // 小口（ジャム）は壁の幾何なので記号の表には入れない
    const w = strokeWidth(layer);
    for (const jamb of openingJambs(f)) out.push(lineTag(jamb.a, jamb.b, layer.color, w));
    out.push(...svgPrimitives(openingPrimitives(scene, op), layer, std));
  }

  // --- ブロックの挿入 ---
  for (const inst of Object.values(scene.instances)) {
    const layer = layerOf(inst.layerId, LAYER_IDS.furniture);
    if (!visible(layer)) continue;
    const def = blockOf(scene, inst);
    if (!def) continue;
    out.push(
      `<polygon points="${pointsAttr(instanceVertices(scene, inst))}" fill="rgba(120,113,108,0.14)" stroke="none"/>`,
    );
    out.push(...svgPrimitives(instancePrimitives(scene, inst, std), layer, std));

    const label = instanceLabel(scene, inst);
    const nameSize = paperToWorld(std.textHeight.furniture, std);
    if (labelFits(label, instanceSize(def, inst), nameSize)) {
      out.push(textTag(label, vec(inst.x, inst.y), toDeg(inst.angle), nameSize, theme.furnitureText));
    }
  }

  // --- 汎用図形 ---
  for (const shape of Object.values(scene.shapes)) {
    const layer = layerOf(shape.layerId, LAYER_IDS.shape);
    if (!visible(layer)) continue;
    out.push(...svgPrimitives(shapePrimitives(scene, shape, std), layer, std));
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






import {
  add,
  angleOf,
  dist,
  mid,
  mul,
  norm,
  perp,
  signedArea,
  sub,
  vec,
  type Vec,
} from '../core/geometry.ts';
import { isSnappable } from '../core/entity.ts';
import { wallEnds } from '../core/ops.ts';
import { CONSTRAINT_SPECS } from '../core/constraints.ts';
import { LAYER_IDS } from '../core/layer.ts';
import { toTatami } from '../core/rooms.ts';

import { openingFrame, openingJambs, openingQuad, wallOutline, wallQuad } from '../core/shape.ts';
import { openingPrimitives } from '../core/opening.ts';
import {
  blockOf,
  instanceLabel,
  instancePrimitives,
  instanceSize,
  instanceVertices,
  labelFits,
} from '../core/block.ts';
import { shapePrimitives } from '../core/shapes.ts';
import { sheetPrimitives } from '../core/sheet.ts';
import { fontOf, theme } from './theme.ts';
import { drawPrimitives } from './primitive.ts';
import {
  applyLayer,
  layerFor,
  normalizeTextAngle,
  refKey,
  strokeSegments,
  textPx,
  tracePolygon,
  type Frame,
} from './frame.ts';

export { refKey, type Frame };



export function render(frame: Frame, overlay?: (f: Frame) => void): void {
  const { ctx, vp } = frame;
  ctx.save();
  ctx.fillStyle = theme.paper;
  ctx.fillRect(0, 0, vp.width, vp.height);

  if (frame.settings.showGrid) drawGrid(frame);
  drawSheet(frame);
  drawRooms(frame);
  drawWalls(frame);
  drawOpenings(frame);
  drawInstances(frame);
  drawShapes(frame);
  drawRoomLabels(frame);
  drawNodes(frame);
  drawConstraints(frame);
  ctx.setLineDash([]);
  overlay?.(frame);
  ctx.restore();
}

// --- グリッド ---

function drawGrid(frame: Frame): void {
  const { ctx, vp, settings } = frame;
  const bounds = vp.visibleBounds();

  // 画面上で 8px を下回らないところまでグリッドを間引く
  let step = settings.gridSize;
  const ladder = [1, 2, 5];
  let k = 0;
  while (vp.toScreenLength(step) < 8 && step < 1e7) {
    k += 1;
    step = settings.gridSize * ladder[k % 3] * Math.pow(10, Math.floor(k / 3));
  }
  const major = step * 10;

  ctx.setLineDash([]);
  const line = (a: Vec, b: Vec, color: string, width: number) => {
    const sa = vp.toScreen(a);
    const sb = vp.toScreen(b);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
  };

  const x0 = Math.floor(bounds.min.x / step) * step;
  const y0 = Math.floor(bounds.min.y / step) * step;

  for (let x = x0; x <= bounds.max.x; x += step) {
    const isMajor = Math.abs(x % major) < step / 2;
    line(vec(x, bounds.min.y), vec(x, bounds.max.y), isMajor ? theme.gridMajor : theme.gridMinor, 1);
  }
  for (let y = y0; y <= bounds.max.y; y += step) {
    const isMajor = Math.abs(y % major) < step / 2;
    line(vec(bounds.min.x, y), vec(bounds.max.x, y), isMajor ? theme.gridMajor : theme.gridMinor, 1);
  }

  line(vec(bounds.min.x, 0), vec(bounds.max.x, 0), theme.axis, 1.5);
  line(vec(0, bounds.min.y), vec(0, bounds.max.y), theme.axis, 1.5);
}

// --- 用紙枠と表題欄 ---

function drawSheet(frame: Frame): void {
  const { scene } = frame;
  if (!scene.sheet.show) return;
  const layer = layerFor(frame, LAYER_IDS.sheet, LAYER_IDS.sheet);
  if (!layer.visible) return;
  drawPrimitives(frame, sheetPrimitives(scene.sheet, scene.standard), layer);
}

// --- 部屋 ---


function drawRooms(frame: Frame): void {
  const { ctx, rooms } = frame;
  ctx.setLineDash([]);
  for (const room of rooms) {
    const poly = room.innerPolygon.length >= 3 ? room.innerPolygon : room.polygon;
    tracePolygon(frame, poly);
    ctx.fillStyle = theme.roomFill;
    ctx.fill();
    ctx.fillStyle = theme.roomFillAlt;
    ctx.fill();
  }
}

/** 室名と面積。壁や家具の上に出したいので最後に描く */
function drawRoomLabels(frame: Frame): void {
  const { ctx, vp, rooms, settings, scene } = frame;
  const layer = layerFor(frame, LAYER_IDS.roomName, LAYER_IDS.roomName);
  if (!layer.visible) return;
  const std = scene.standard;
  ctx.setLineDash([]);

  for (const room of rooms) {
    const c = vp.toScreen(room.center);
    const area = settings.innerArea ? room.innerArea : room.area;
    if (vp.toScreenLength(Math.sqrt(area * 1e6)) < 44) continue;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const nameSize = textPx(std.textHeight.room);
    const areaSize = textPx(std.textHeight.area);
    if (room.name) {
      ctx.font = fontOf(nameSize, 600);
      ctx.fillStyle = layer.color;
      ctx.fillText(room.name, c.x, c.y - areaSize * 0.75);
    }
    ctx.font = fontOf(areaSize);
    ctx.fillStyle = theme.roomArea;
    ctx.fillText(
      `${area.toFixed(2)} m²  (${toTatami(area).toFixed(1)}帖)`,
      c.x,
      c.y + (room.name ? nameSize * 0.55 : 0),
    );
  }
}

// --- 壁 ---

function drawWalls(frame: Frame): void {
  const { ctx, scene, selected, hover } = frame;
  const fill = scene.standard.wallFill;

  const fillQuad = (quad: Vec[], style: string) => {
    // 重なり部分が nonzero 規則で消えないよう、向きを反時計回りに揃える
    const oriented = signedArea(quad) < 0 ? [...quad].reverse() : quad;
    tracePolygon(frame, oriented);
    ctx.fillStyle = style;
    ctx.fill();
  };

  ctx.setLineDash([]);
  for (const wall of Object.values(scene.walls)) {
    const layer = layerFor(frame, wall.layerId, LAYER_IDS.wall);
    if (!layer.visible) continue;
    const accent = selected.has(`wall:${wall.id}`)
      ? theme.wallSelected
      : hover?.type === 'wall' && hover.id === wall.id
        ? theme.wallHover
        : null;
    // 塗らない設定でも、下の部屋塗りを隠すために紙の色で埋める
    fillQuad(wallQuad(scene, wall), fill ? (accent ?? layer.color) : theme.paper);
  }

  // 開口部を紙の色で抜く
  for (const op of Object.values(scene.openings)) {
    const f = openingFrame(scene, op);
    if (!f) continue;
    fillQuad(openingQuad(f), theme.paper);
  }

  if (fill) return;

  // 輪郭線表示: 壁の両側の線を、開口部を除いて引く
  for (const wall of Object.values(scene.walls)) {
    const layer = layerFor(frame, wall.layerId, LAYER_IDS.wall);
    if (!layer.visible) continue;
    const accent = selected.has(`wall:${wall.id}`)
      ? theme.wallSelected
      : hover?.type === 'wall' && hover.id === wall.id
        ? theme.wallHover
        : null;
    applyLayer(frame, layer, accent);
    strokeSegments(frame, wallOutline(scene, wall));
  }
}


// --- 開口部（ドア・窓）---

function drawOpenings(frame: Frame): void {
  const { scene, selected, hover } = frame;
  for (const op of Object.values(scene.openings)) {
    const layer = layerFor(frame, op.layerId, LAYER_IDS.opening);
    if (!layer.visible) continue;
    const f = openingFrame(scene, op);
    if (!f) continue;
    const accent = selected.has(`opening:${op.id}`)
      ? theme.wallSelected
      : hover?.type === 'opening' && hover.id === op.id
        ? theme.wallHover
        : null;

    // 小口（ジャム）は壁の幾何なので記号の表には入れない
    applyLayer(frame, layer, accent);
    strokeSegments(frame, openingJambs(f));

    drawPrimitives(frame, openingPrimitives(scene, op), layer, accent);
  }
}



// --- ブロックの挿入 ---

/**
 * ブロックは中身を図形として持つので、記号ごとの分岐は要らない。
 * 以前は家具の種類による switch を renderer が持っていた。
 */
function drawInstances(frame: Frame): void {
  const { ctx, vp, scene, selected, hover } = frame;
  const std = scene.standard;

  for (const inst of Object.values(scene.instances)) {
    const layer = layerFor(frame, inst.layerId, LAYER_IDS.furniture);
    if (!layer.visible) continue;
    const def = blockOf(scene, inst);
    if (!def) continue;

    const isSelected = selected.has(`blockInstance:${inst.id}`);
    const accent = isSelected
      ? theme.furnitureSelected
      : hover?.type === 'blockInstance' && hover.id === inst.id
        ? theme.wallHover
        : null;

    // 外形の内側を薄く塗って、面として掴める見た目にする
    tracePolygon(frame, instanceVertices(scene, inst));
    ctx.setLineDash([]);
    ctx.fillStyle = theme.furniture;
    ctx.fill();

    drawPrimitives(frame, instancePrimitives(scene, inst, std), layer, accent);

    const size = instanceSize(def, inst);
    const label = instanceLabel(scene, inst);
    const textSize = textPx(std.textHeight.furniture);
    if (labelFits(label, size, vp.toWorldLength(textSize)) && vp.toScreenLength(Math.min(size.w, size.h)) > textSize) {
      const c = vp.toScreen(vec(inst.x, inst.y));
      ctx.save();
      ctx.setLineDash([]);
      ctx.translate(c.x, c.y);
      ctx.rotate(-normalizeTextAngle(inst.angle));
      ctx.font = fontOf(textSize);
      ctx.fillStyle = theme.furnitureText;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
  }
}

// --- 汎用図形 ---

/**
 * 図形は中間表現（Primitive）に落としてから描く。
 * 同じ中間表現を SVG と DXF も使うので、種別を足してもここは変わらない。
 */
function drawShapes(frame: Frame): void {
  const { scene, selected, hover } = frame;
  for (const s of Object.values(scene.shapes)) {
    const layer = layerFor(frame, s.layerId, LAYER_IDS.shape);
    if (!layer.visible) continue;
    const accent = selected.has(`shape:${s.id}`)
      ? theme.wallSelected
      : hover?.type === 'shape' && hover.id === s.id
        ? theme.wallHover
        : null;
    drawPrimitives(frame, shapePrimitives(scene, s, scene.standard), layer, accent);
  }
}


// --- ノード ---

function drawNodes(frame: Frame): void {
  const { ctx, vp, scene, selected, hover } = frame;
  const r = 3.5;
  ctx.setLineDash([]);
  for (const n of Object.values(scene.nodes)) {
    if (!isSnappable(scene, { type: 'node', id: n.id })) continue;
    const isSelected = selected.has(`node:${n.id}`);
    const isHover = hover?.type === 'node' && hover.id === n.id;
    if (!isSelected && !isHover && vp.scale < 0.02) continue;
    const s = vp.toScreen(vec(n.x, n.y));
    ctx.beginPath();
    ctx.rect(s.x - r, s.y - r, r * 2, r * 2);
    ctx.fillStyle = isSelected ? theme.nodeSelected : theme.node;
    ctx.fill();
    ctx.strokeStyle = isSelected ? theme.nodeSelected : isHover ? theme.wallSelected : theme.nodeStroke;
    ctx.lineWidth = isHover || isSelected ? 2 : 1;
    ctx.stroke();
  }
}

/**
 * 幾何拘束の記号。
 *
 * 壁の中点のそばに、ズームに依らない大きさで小さく置く。
 * 同じ壁に複数付いていれば法線方向にずらして並べる。
 * 壁そのものはハイライトしない — 選択色・ホバー色・画層色の3系統が既にあり、
 * 4つ目を重ねると読めなくなるため。
 *
 * 使うのは fillText と measureText だけなので、テストの Canvas スタブがそのまま通る。
 */
function drawConstraints(frame: Frame): void {
  const { ctx, vp, scene, settings } = frame;
  if (!settings.showConstraints) return;
  const all = Object.values(scene.constraints);
  if (all.length === 0) return;

  const violated = frame.violated ?? new Set<string>();
  const used = new Map<string, number>();

  ctx.save();
  ctx.setLineDash([]);
  ctx.font = fontOf(11, 600);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const c of all) {
    ctx.fillStyle = violated.has(c.id) ? theme.constraintConflict : theme.constraint;
    // 平行・直角は2本の壁の関係なので、両方に同じ記号を出す。でないと相手が分からない
    for (const wallId of c.walls) {
      const wall = scene.walls[wallId];
      if (!wall) continue;
      const [a, b] = wallEnds(scene, wall);
      const d = norm(sub(b, a));
      if (d.x === 0 && d.y === 0) continue;
      const n = perp(d);
      const slot = used.get(wallId) ?? 0;
      used.set(wallId, slot + 1);

      const s = vp.toScreen(vec((a.x + b.x) / 2, (a.y + b.y) / 2));
      // 法線方向に 14px ずつ重ねる。画面は y 下向きなので符号を反転する
      ctx.fillText(CONSTRAINT_SPECS[c.kind].glyph, s.x + n.x * 14 * (slot + 1), s.y - n.y * 14 * (slot + 1));
    }
  }
  ctx.restore();
}

// --- ツールのプレビュー描画に使う共通部品 ---

export function drawSnapMarker(frame: Frame, p: Vec, label: string): void {
  const { ctx, vp } = frame;
  const s = vp.toScreen(p);
  ctx.save();
  ctx.setLineDash([]);
  ctx.strokeStyle = theme.snap;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.rect(s.x - 6, s.y - 6, 12, 12);
  ctx.stroke();
  if (label) {
    ctx.font = fontOf(11);
    ctx.fillStyle = theme.snap;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, s.x + 9, s.y - 7);
  }
  ctx.restore();
}

export function drawPreviewWall(frame: Frame, a: Vec, b: Vec, thickness: number): void {
  const { ctx, vp } = frame;
  const d = norm(sub(b, a));
  if (d.x === 0 && d.y === 0) return;
  const n = mul(perp(d), thickness / 2);
  ctx.save();
  ctx.setLineDash([]);
  tracePolygon(frame, [add(a, n), add(b, n), sub(b, n), sub(a, n)]);
  ctx.fillStyle = 'rgba(37, 99, 235, 0.25)';
  ctx.fill();
  ctx.strokeStyle = theme.preview;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 作図中は長さと角度を常に出す
  const lengthMm = dist(a, b);
  const angle = ((angleOf(d) * 180) / Math.PI + 360) % 360;
  const s = vp.toScreen(mid(a, b));
  const text = `${Math.round(lengthMm)} mm  ${angle.toFixed(1)}°`;
  ctx.font = fontOf(12);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillRect(s.x - w / 2 - 5, s.y - 22, w + 10, 18);
  ctx.fillStyle = theme.preview;
  ctx.fillText(text, s.x, s.y - 6);
  ctx.restore();
}

export function drawPreviewRect(frame: Frame, a: Vec, b: Vec, crossing: boolean): void {
  const { ctx, vp } = frame;
  const sa = vp.toScreen(a);
  const sb = vp.toScreen(b);
  ctx.save();
  ctx.fillStyle = crossing ? theme.crossingRect : theme.selectionRect;
  ctx.strokeStyle = crossing ? theme.crossingRectStroke : theme.selectionRectStroke;
  ctx.lineWidth = 1;
  ctx.setLineDash(crossing ? [5, 3] : []);
  ctx.beginPath();
  ctx.rect(Math.min(sa.x, sb.x), Math.min(sa.y, sb.y), Math.abs(sb.x - sa.x), Math.abs(sb.y - sa.y));
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

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
import { getLayer, LAYER_IDS, layerDashWorld, layerWeight, type Layer } from '../core/layer.ts';
import { wallEnds } from '../core/ops.ts';
import { dimensionSide, toTatami } from '../core/rooms.ts';
import { PX_PER_MM, paperToScreenPx } from '../core/standard.ts';
import {
  doorSwing,
  furnitureLabelFits,
  furniturePolygon,
  openingFrame,
  openingQuad,
  wallOutline,
  wallQuad,
} from '../core/shape.ts';
import type { Settings } from '../core/store.ts';
import type { EntityRef, Furniture, Room, Scene } from '../core/types.ts';
import { fontOf, theme } from './theme.ts';
import { Viewport } from './viewport.ts';

export interface Frame {
  ctx: CanvasRenderingContext2D;
  vp: Viewport;
  scene: Scene;
  rooms: Room[];
  settings: Settings;
  selected: Set<string>;
  hover: EntityRef | null;
}

export const refKey = (ref: EntityRef): string => `${ref.type}:${ref.id}`;

/** 画層を引く。見つからなければ既定の画層に落とす */
const layerFor = (frame: Frame, id: string | undefined, fallback: string): Layer =>
  getLayer(frame.scene.layers, id, fallback);

/**
 * 線の太さは「紙の上の mm」なので、画面ではズームに依らず一定のピクセル数で描く。
 * CAD の線幅表示と同じ考え方。
 */
const strokePx = (frame: Frame, layer: Layer): number =>
  paperToScreenPx(layerWeight(layer, frame.scene.standard));

/** 文字も紙の上の mm。画面は「原寸の紙」として扱う */
const textPx = (paperMm: number): number => Math.max(8, paperMm * PX_PER_MM);

/** 線種のダッシュを画面のピクセルに直す。ワールド基準なのでズームに追従する */
function dashPx(frame: Frame, layer: Layer): number[] {
  return layerDashWorld(layer, frame.scene.standard).map((mm) => Math.max(1, frame.vp.toScreenLength(mm)));
}

function applyLayer(frame: Frame, layer: Layer, overrideColor?: string | null): void {
  const { ctx } = frame;
  ctx.strokeStyle = overrideColor ?? layer.color;
  ctx.lineWidth = strokePx(frame, layer);
  ctx.setLineDash(dashPx(frame, layer));
}

export function render(frame: Frame, overlay?: (f: Frame) => void): void {
  const { ctx, vp } = frame;
  ctx.save();
  ctx.fillStyle = theme.paper;
  ctx.fillRect(0, 0, vp.width, vp.height);

  if (frame.settings.showGrid) drawGrid(frame);
  drawRooms(frame);
  drawWalls(frame);
  drawOpenings(frame);
  drawFurniture(frame);
  if (frame.settings.showDimensions) drawDimensions(frame);
  drawRoomLabels(frame);
  drawNodes(frame);
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

// --- 部屋 ---

function tracePolygon(frame: Frame, poly: Vec[]): void {
  const { ctx, vp } = frame;
  ctx.beginPath();
  poly.forEach((p, i) => {
    const s = vp.toScreen(p);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  ctx.closePath();
}

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

function strokeSegments(frame: Frame, segments: { a: Vec; b: Vec }[]): void {
  const { ctx, vp } = frame;
  ctx.beginPath();
  for (const s of segments) {
    const a = vp.toScreen(s.a);
    const b = vp.toScreen(s.b);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
}

// --- 開口部（ドア・窓）---

function drawOpenings(frame: Frame): void {
  const { ctx, vp, scene, selected, hover } = frame;
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
    applyLayer(frame, layer, accent);

    // 開口の両端に小口（ジャム）を描く
    const half = mul(f.normal, f.thickness / 2);
    strokeSegments(frame, [
      { a: add(f.start, half), b: sub(f.start, half) },
      { a: add(f.end, half), b: sub(f.end, half) },
    ]);

    if (op.kind === 'window') {
      // JIS A 0150 の窓記号に倣い、壁厚の中に2本の平行線を入れる
      const lines = [-0.5, 0.5].map((t) => {
        const off = mul(f.normal, (f.thickness / 2) * t);
        return { a: add(f.start, off), b: add(f.end, off) };
      });
      strokeSegments(frame, lines);
    } else if (op.kind === 'door') {
      const swing = doorSwing(f, op.flipX, op.flipY);
      strokeSegments(frame, [{ a: swing.hinge, b: swing.open }]);
      const s = vp.toScreen(swing.hinge);
      const r = vp.toScreenLength(swing.radius);
      // 画面は y 下向きなので角度の符号を反転して描く
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(
        s.x,
        s.y,
        r,
        -angleOf(sub(swing.open, swing.hinge)),
        -angleOf(sub(swing.closed, swing.hinge)),
        swing.ccwFromOpenToClosed,
      );
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

// --- 家具 ---

function drawFurniture(frame: Frame): void {
  const { ctx, vp, scene, selected, hover } = frame;
  const std = scene.standard;
  for (const f of Object.values(scene.furniture)) {
    const layer = layerFor(frame, f.layerId, LAYER_IDS.furniture);
    if (!layer.visible) continue;
    const corners = furniturePolygon(f);
    const isSelected = selected.has(`furniture:${f.id}`);
    const isHover = hover?.type === 'furniture' && hover.id === f.id;

    tracePolygon(frame, corners);
    ctx.setLineDash([]);
    ctx.fillStyle = theme.furniture;
    ctx.fill();
    applyLayer(frame, layer, isSelected ? theme.furnitureSelected : isHover ? theme.wallHover : null);
    if (isSelected) ctx.lineWidth = Math.max(2, ctx.lineWidth);
    ctx.stroke();

    drawFurnitureGlyph(frame, f, corners, layer);

    const size = textPx(std.textHeight.furniture);
    const worldSize = vp.toWorldLength(size);
    if (furnitureLabelFits(f.name, f, worldSize) && vp.toScreenLength(Math.min(f.w, f.h)) > size) {
      const c = vp.toScreen(vec(f.x, f.y));
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(-normalizeTextAngle(f.angle));
      ctx.font = fontOf(size);
      ctx.fillStyle = theme.furnitureText;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(f.name, 0, 0);
      ctx.restore();
    }
  }
}

/** 家具ごとの簡単な記号。細部より「それらしさ」を優先している */
function drawFurnitureGlyph(frame: Frame, f: Furniture, corners: Vec[], layer: Layer): void {
  const { ctx, vp } = frame;
  ctx.save();
  applyLayer(frame, layer);
  const strokeLine = (a: Vec, b: Vec) => strokeSegments(frame, [{ a, b }]);
  switch (f.kind) {
    case 'bed': {
      // 枕側に1本線を入れて頭の向きを示す
      const t = 0.26;
      strokeLine(lerpPt(corners[0], corners[3], t), lerpPt(corners[1], corners[2], t));
      break;
    }
    case 'stairs': {
      const steps = Math.max(2, Math.round(f.h / 250));
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        strokeLine(lerpPt(corners[0], corners[3], t), lerpPt(corners[1], corners[2], t));
      }
      break;
    }
    case 'bath':
    case 'sink':
    case 'toilet':
    case 'kitchen': {
      const c = vp.toScreen(vec(f.x, f.y));
      const ratio = f.kind === 'kitchen' ? 0.22 : 0.32;
      const r = vp.toScreenLength(Math.min(f.w, f.h) * ratio);
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, r, r, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    default:
      break;
  }
  ctx.restore();
}

const lerpPt = (a: Vec, b: Vec, t: number): Vec => add(a, mul(sub(b, a), t));

function normalizeTextAngle(angle: number): number {
  // 文字が上下逆にならないよう ±90° の範囲に畳む
  let a = angle;
  while (a > Math.PI / 2) a -= Math.PI;
  while (a < -Math.PI / 2) a += Math.PI;
  return a;
}

// --- 寸法 ---

function drawDimensions(frame: Frame): void {
  const { ctx, vp, scene, rooms } = frame;
  const layer = layerFor(frame, LAYER_IDS.dimension, LAYER_IDS.dimension);
  if (!layer.visible) return;
  const size = textPx(scene.standard.textHeight.dimension);
  ctx.setLineDash([]);

  for (const wall of Object.values(scene.walls)) {
    const [a, b] = wallEnds(scene, wall);
    const lengthMm = dist(a, b);
    if (vp.toScreenLength(lengthMm) < size * 4) continue;
    const d = norm(sub(b, a));
    const n = perp(d);
    const center0 = mid(a, b);
    const side = dimensionSide(rooms, center0, n, wall.thickness / 2 + 150);
    const offset = mul(n, side * (wall.thickness / 2 + vp.toWorldLength(size * 1.1)));
    const s = vp.toScreen(add(center0, offset));

    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(-normalizeTextAngle(angleOf(d)));
    ctx.font = fontOf(size);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = `${Math.round(lengthMm)}`;
    const w = ctx.measureText(text).width;
    ctx.fillStyle = theme.paper;
    ctx.fillRect(-w / 2 - 3, -size * 0.65, w + 6, size * 1.3);
    ctx.fillStyle = layer.color;
    ctx.fillText(text, 0, 0);
    ctx.restore();
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

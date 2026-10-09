import { add, angleOf, dist, dot, mid, mul, norm, perp, sub, vec, type Vec } from './geometry.ts';
import { LAYER_IDS } from './layer.ts';
import { newId } from './id.ts';
import { nodePos, wallEnds } from './ops.ts';
import type { Primitive } from './primitive.ts';
import { dimensionSide, detectRooms } from './rooms.ts';
import type { Segment } from './shape.ts';
import type { DimEnd, DimensionShape } from './shapes.ts';
import { paperToWorld, type DrawingStandard } from './standard.ts';
import type { Scene } from './types.ts';

/** 端部の斜線の長さ（紙の上の mm）。建築では矢印でなく45度の斜線を使う */
const TICK_PAPER_MM = 1.2;
/** 寸法補助線を寸法線より少し伸ばす量（紙の上の mm） */
const EXTENSION_OVERSHOOT_PAPER_MM = 1.2;

export interface DimensionGeometry {
  /** 解決済みの計測点 */
  a: Vec;
  b: Vec;
  dir: Vec;
  normal: Vec;
  /** 寸法線 */
  line: Segment;
  /** 寸法補助線 */
  extensions: [Segment, Segment];
  /** 端部の斜線 */
  ticks: Segment[];
  textAt: Vec;
  textAngle: number;
  text: string;
  /** 実測値 (mm) */
  value: number;
}

/** 端点の実座標。ノードに紐づいていればそちらを優先する */
export function dimEndPoint(scene: Scene, end: DimEnd): Vec {
  if (end.nodeId && scene.nodes[end.nodeId]) return nodePos(scene, end.nodeId);
  return vec(end.x, end.y);
}

export function dimensionGeometry(
  scene: Scene,
  d: DimensionShape,
  std: DrawingStandard,
): DimensionGeometry | null {
  const a = dimEndPoint(scene, d.a);
  const b = dimEndPoint(scene, d.b);
  const value = dist(a, b);
  if (value < 1e-6) return null;

  const dir = norm(sub(b, a));
  const normal = perp(dir);
  const off = mul(normal, d.offset);
  const lineA = add(a, off);
  const lineB = add(b, off);

  const overshoot = mul(normal, Math.sign(d.offset || 1) * paperToWorld(EXTENSION_OVERSHOOT_PAPER_MM, std));
  const tick = paperToWorld(TICK_PAPER_MM, std);
  // 45度の斜線。寸法線の向きと補助線の向きの中間を向く
  const slash = mul(add(dir, normal), tick / Math.SQRT2);

  return {
    a,
    b,
    dir,
    normal,
    line: { a: lineA, b: lineB },
    extensions: [
      { a, b: add(lineA, overshoot) },
      { a: b, b: add(lineB, overshoot) },
    ],
    ticks: [
      { a: sub(lineA, slash), b: add(lineA, slash) },
      { a: sub(lineB, slash), b: add(lineB, slash) },
    ],
    textAt: add(mid(lineA, lineB), mul(normal, Math.sign(d.offset || 1) * paperToWorld(std.textHeight.dimension * 0.7, std))),
    textAngle: angleOf(dir),
    text: d.override ?? String(Math.round(value)),
    value,
  };
}

export function dimensionPrimitives(scene: Scene, d: DimensionShape, std: DrawingStandard): Primitive[] {
  const g = dimensionGeometry(scene, d, std);
  if (!g) return [];
  return [
    { kind: 'segments', segments: [g.line, ...g.extensions, ...g.ticks] },
    {
      kind: 'text',
      text: g.text,
      at: g.textAt,
      paperMm: std.textHeight.dimension,
      angle: g.textAngle,
      align: 'center',
    },
  ];
}

/**
 * ドラッグで寸法を動かす。
 * 両端とも壁の角に紐づいている場合は、寸法線の出る側（オフセット）だけが動く。
 * 自由点を含む場合は、その点が変位ぶんだけ動く。
 */
export function moveDimension(scene: Scene, d: DimensionShape, delta: Vec): DimensionShape {
  const a = dimEndPoint(scene, d.a);
  const b = dimEndPoint(scene, d.b);
  const anchored = (end: DimEnd) => end.nodeId !== null && scene.nodes[end.nodeId] !== undefined;

  if (anchored(d.a) && anchored(d.b)) {
    const normal = perp(norm(sub(b, a)));
    return { ...d, offset: d.offset + dot(delta, normal) };
  }
  const moveEnd = (end: DimEnd, point: Vec): DimEnd =>
    anchored(end) ? end : { x: point.x + delta.x, y: point.y + delta.y, nodeId: null };
  return { ...d, a: moveEnd(d.a, a), b: moveEnd(d.b, b) };
}

/**
 * 壁ごとの寸法を作る。
 * 旧ファイル（全壁に自動表示していた時代のもの）の移行と、サンプル間取りで使う。
 * 外壁は建物の外、間仕切りは室内側へ出す判定は `dimensionSide` が既に持っている。
 */
export function createWallDimensions(scene: Scene): DimensionShape[] {
  const rooms = detectRooms(scene);
  const std = scene.standard;
  const gap = paperToWorld(std.textHeight.dimension * 1.6, std);
  const out: DimensionShape[] = [];

  for (const wall of Object.values(scene.walls)) {
    const [a, b] = wallEnds(scene, wall);
    const length = dist(a, b);
    if (length < gap) continue;
    const normal = perp(norm(sub(b, a)));
    const side = dimensionSide(rooms, mid(a, b), normal, wall.thickness / 2 + 150);
    out.push({
      id: newId('dim'),
      shape: 'dimension',
      layerId: LAYER_IDS.dimension,
      a: { x: a.x, y: a.y, nodeId: wall.a },
      b: { x: b.x, y: b.y, nodeId: wall.b },
      offset: side * (wall.thickness / 2 + gap),
      override: null,
    });
  }
  return out;
}

import {
  add,
  angleOf,
  closestOnSegment,
  dist,
  mid,
  normalizeAngle,
  pointInPolygon,
  rotate,
  vec,
  type Vec,
} from './geometry.ts';
import { LAYER_IDS, type LayerId } from './layer.ts';
import type { Primitive, TextAlign } from './primitive.ts';
import type { Segment } from './shape.ts';
import type { SnapKind } from './snap.ts';
import type { DrawingStandard } from './standard.ts';
import type { Id, Scene } from './types.ts';

interface ShapeBase {
  id: Id;
  layerId: LayerId;
}

export interface LineShape extends ShapeBase {
  shape: 'line';
  a: Vec;
  b: Vec;
}

export interface PolylineShape extends ShapeBase {
  shape: 'polyline';
  /** 2点以上。矩形や多角形は closed: true で表す（専用の型は作らない） */
  points: Vec[];
  closed: boolean;
}

export interface ArcShape extends ShapeBase {
  shape: 'arc';
  center: Vec;
  radius: number;
  /**
   * ワールド(y上向き)基準のラジアン。
   * start から end へ**常に反時計回り**、という不変条件を持たせる。
   * 円弧の向きは Canvas / SVG / DXF で約束が違うので、ここで一度決めておく。
   */
  startAngle: number;
  endAngle: number;
}

export interface CircleShape extends ShapeBase {
  shape: 'circle';
  center: Vec;
  radius: number;
}

export interface TextShape extends ShapeBase {
  shape: 'text';
  at: Vec;
  text: string;
  /** 文字高（紙の上の mm）。製図規格の textHeight と同じ土俵に乗せる */
  height: number;
  angle: number;
  align: TextAlign;
}

export interface PointShape extends ShapeBase {
  shape: 'point';
  at: Vec;
}

export type Shape = LineShape | PolylineShape | ArcShape | CircleShape | TextShape | PointShape;
export type ShapeKind = Shape['shape'];

/**
 * 図形の種別ごとの幾何。DOM には触らない。
 *
 * `Record<ShapeKind, ...>` で持つことで、種別を足したときに
 * 埋め忘れが型エラーとして出る。コンパイラをチェックリストとして使う。
 */
export interface ShapeGeometry<S extends Shape = Shape> {
  label: string;
  defaultLayer: LayerId;
  /** 代表点。範囲選択と図面範囲に使う */
  vertices(scene: Scene, s: S): Vec[];
  /** 当たり判定用の折れ線近似。円・円弧はここで分割する */
  outline(scene: Scene, s: S): Segment[];
  /** ピックの優先度。小さいほど先に拾う */
  pickPriority: number;
  snapPoints(scene: Scene, s: S): { point: Vec; kind: SnapKind }[];
  primitives(scene: Scene, s: S, std: DrawingStandard): Primitive[];
}

/** 円弧を折れ線に分割するときの最大の刻み（ラジアン）。約11.25度 */
const ARC_STEP = Math.PI / 16;

/** 点を表す十字の腕の長さ（紙の上の mm） */
const POINT_MARK_PAPER_MM = 1.5;

export function arcSweep(s: ArcShape): number {
  const sweep = normalizeAngle(s.endAngle - s.startAngle);
  // 始点と終点が一致する円弧は「全周」とみなす
  return sweep < 1e-9 ? Math.PI * 2 : sweep;
}

export function arcPointAt(center: Vec, radius: number, angle: number): Vec {
  return add(center, vec(Math.cos(angle) * radius, Math.sin(angle) * radius));
}

function arcPolyline(center: Vec, radius: number, start: number, sweep: number): Vec[] {
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / ARC_STEP));
  const points: Vec[] = [];
  for (let i = 0; i <= steps; i++) {
    points.push(arcPointAt(center, radius, start + (sweep * i) / steps));
  }
  return points;
}

function chain(points: Vec[], closed: boolean): Segment[] {
  const segments: Segment[] = [];
  for (let i = 0; i + 1 < points.length; i++) segments.push({ a: points[i], b: points[i + 1] });
  if (closed && points.length > 2) segments.push({ a: points[points.length - 1], b: points[0] });
  return segments;
}

function segmentMidpoints(points: Vec[], closed: boolean): { point: Vec; kind: SnapKind }[] {
  return chain(points, closed).map((s) => ({ point: mid(s.a, s.b), kind: 'midpoint' as const }));
}

export const SHAPE_GEOMETRY: { [K in ShapeKind]: ShapeGeometry<Extract<Shape, { shape: K }>> } = {
  line: {
    label: '線',
    defaultLayer: LAYER_IDS.shape,
    pickPriority: 5,
    vertices: (_scene, s) => [s.a, s.b],
    outline: (_scene, s) => [{ a: s.a, b: s.b }],
    snapPoints: (_scene, s) => [
      { point: s.a, kind: 'node' },
      { point: s.b, kind: 'node' },
      { point: mid(s.a, s.b), kind: 'midpoint' },
    ],
    primitives: (_scene, s) => [{ kind: 'segments', segments: [{ a: s.a, b: s.b }] }],
  },

  polyline: {
    label: 'ポリライン',
    defaultLayer: LAYER_IDS.shape,
    pickPriority: 5,
    vertices: (_scene, s) => s.points,
    outline: (_scene, s) => chain(s.points, s.closed),
    snapPoints: (_scene, s) => [
      ...s.points.map((p) => ({ point: p, kind: 'node' as const })),
      ...segmentMidpoints(s.points, s.closed),
    ],
    primitives: (_scene, s) => [{ kind: 'segments', segments: chain(s.points, s.closed) }],
  },

  arc: {
    label: '円弧',
    defaultLayer: LAYER_IDS.shape,
    pickPriority: 5,
    vertices: (_scene, s) => arcPolyline(s.center, s.radius, s.startAngle, arcSweep(s)),
    outline: (_scene, s) => chain(arcPolyline(s.center, s.radius, s.startAngle, arcSweep(s)), false),
    snapPoints: (_scene, s) => {
      const sweep = arcSweep(s);
      return [
        { point: arcPointAt(s.center, s.radius, s.startAngle), kind: 'node' },
        { point: arcPointAt(s.center, s.radius, s.endAngle), kind: 'node' },
        { point: arcPointAt(s.center, s.radius, s.startAngle + sweep / 2), kind: 'midpoint' },
        { point: s.center, kind: 'center' },
      ];
    },
    primitives: (_scene, s) => [
      { kind: 'arc', center: s.center, radius: s.radius, startAngle: s.startAngle, endAngle: s.endAngle },
    ],
  },

  circle: {
    label: '円',
    defaultLayer: LAYER_IDS.shape,
    pickPriority: 5,
    vertices: (_scene, s) => [
      add(s.center, vec(-s.radius, 0)),
      add(s.center, vec(s.radius, 0)),
      add(s.center, vec(0, -s.radius)),
      add(s.center, vec(0, s.radius)),
    ],
    outline: (_scene, s) => chain(arcPolyline(s.center, s.radius, 0, Math.PI * 2), false),
    snapPoints: (_scene, s) => [
      { point: s.center, kind: 'center' },
      // 四分点。CAD で円に取り付くときの定番
      ...[0, 0.5, 1, 1.5].map((q) => ({
        point: arcPointAt(s.center, s.radius, q * Math.PI),
        kind: 'node' as const,
      })),
    ],
    primitives: (_scene, s) => [{ kind: 'circle', center: s.center, radius: s.radius }],
  },

  text: {
    label: '文字',
    defaultLayer: LAYER_IDS.roomName,
    pickPriority: 1,
    vertices: (_scene, s) => [s.at],
    outline: (_scene, s) => [{ a: s.at, b: s.at }],
    snapPoints: (_scene, s) => [{ point: s.at, kind: 'node' }],
    primitives: (_scene, s) => [
      { kind: 'text', text: s.text, at: s.at, paperMm: s.height, angle: s.angle, align: s.align },
    ],
  },

  point: {
    label: '点',
    defaultLayer: LAYER_IDS.shape,
    pickPriority: 0,
    vertices: (_scene, s) => [s.at],
    outline: (_scene, s) => [{ a: s.at, b: s.at }],
    snapPoints: (_scene, s) => [{ point: s.at, kind: 'node' }],
    primitives: (_scene, s, std) => {
      // 十字。大きさは尺度に追従させる
      const r = POINT_MARK_PAPER_MM * std.scale;
      return [
        {
          kind: 'segments',
          segments: [
            { a: add(s.at, vec(-r, 0)), b: add(s.at, vec(r, 0)) },
            { a: add(s.at, vec(0, -r)), b: add(s.at, vec(0, r)) },
          ],
        },
      ];
    },
  },
};

export const SHAPE_KINDS = Object.keys(SHAPE_GEOMETRY) as ShapeKind[];

/** 種別を気にせず幾何を引くための入口 */
export function shapeOutline(scene: Scene, s: Shape): Segment[] {
  return SHAPE_GEOMETRY[s.shape].outline(scene, s as never);
}
export function shapeVertices(scene: Scene, s: Shape): Vec[] {
  return SHAPE_GEOMETRY[s.shape].vertices(scene, s as never);
}
export function shapeSnapPoints(scene: Scene, s: Shape): { point: Vec; kind: SnapKind }[] {
  return SHAPE_GEOMETRY[s.shape].snapPoints(scene, s as never);
}
export function shapePrimitives(scene: Scene, s: Shape, std: DrawingStandard): Primitive[] {
  return SHAPE_GEOMETRY[s.shape].primitives(scene, s as never, std);
}
export function shapePickPriority(s: Shape): number {
  return SHAPE_GEOMETRY[s.shape].pickPriority;
}

/**
 * 当たり判定。掴めていれば距離を、外れていれば null を返す。
 * 文字だけは線ではなく外接矩形の内側で掴む。
 */
export function shapeHitTest(
  scene: Scene,
  s: Shape,
  p: Vec,
  tolerance: number,
  std: DrawingStandard,
): number | null {
  if (s.shape === 'text') {
    return pointInPolygon(p, textBox(s, std)) ? dist(p, s.at) : null;
  }
  const d = shapeDistance(scene, s, p);
  return d <= tolerance ? d : null;
}

/** 点から図形までの距離。折れ線近似で測る */
export function shapeDistance(scene: Scene, s: Shape, p: Vec): number {
  let best = Infinity;
  for (const seg of shapeOutline(scene, s)) {
    const d = dist(seg.a, seg.b) < 1e-9 ? dist(p, seg.a) : closestOnSegment(p, seg.a, seg.b).dist;
    if (d < best) best = d;
  }
  return best;
}

/** 文字の当たり判定に使う、おおよその外接矩形 */
export function textBox(s: TextShape, std: DrawingStandard): Vec[] {
  const h = s.height * std.scale;
  const w = Math.max(1, [...s.text].length) * h * 0.95;
  const anchor = s.align === 'left' ? 0 : s.align === 'right' ? -w : -w / 2;
  const corners = [vec(anchor, -h / 2), vec(anchor + w, -h / 2), vec(anchor + w, h / 2), vec(anchor, h / 2)];
  return corners.map((c) => add(s.at, rotate(c, s.angle)));
}

/** 2点から円弧を作る（中心・始点・終点）。常に反時計回りになるよう整える */
export function arcFromPoints(center: Vec, from: Vec, to: Vec): Omit<ArcShape, 'id' | 'layerId' | 'shape'> {
  return {
    center,
    radius: dist(center, from),
    startAngle: angleOf({ x: from.x - center.x, y: from.y - center.y }),
    endAngle: angleOf({ x: to.x - center.x, y: to.y - center.y }),
  };
}

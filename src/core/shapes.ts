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
import type { Attrs } from './attrs.ts';
import { dimEndPoint, dimensionGeometry, dimensionPrimitives } from './dimension.ts';
import { LAYER_IDS, type LayerId } from './layer.ts';
import type { Primitive, TextAlign } from './primitive.ts';
import type { Segment } from './shape.ts';
import type { SnapKind } from './snap.ts';
import type { DrawingStandard } from './standard.ts';
import { applyPoint, directionAngleAfter, isMirror, type Transform } from './transform.ts';
import type { Id, Scene } from './types.ts';

interface ShapeBase {
  id: Id;
  layerId: LayerId;
  /**
   * 乗っている階。
   *
   * **ブロック定義の中の図形では意味を持たない。** 定義はブロック内座標で、
   * どの階に置かれるかは挿入側（`BlockInstance.levelId`）が決める。
   * 定義の中で `layerId` が `A-FURN` 固定なのと同じ扱い。
   */
  levelId: Id;
  attrs: Attrs;
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

/**
 * 寸法の端点。
 * `nodeId` があれば壁の角に紐づき、その角を動かすと寸法の値が追従する。
 * 無ければ自由点。
 */
export interface DimEnd {
  x: number;
  y: number;
  nodeId: Id | null;
}

export interface DimensionShape extends ShapeBase {
  shape: 'dimension';
  a: DimEnd;
  b: DimEnd;
  /** 計測線に対する垂直オフセット (mm)。符号がどちら側に出すかを決める */
  offset: number;
  /** null なら実測値。文字列を入れると表示だけ差し替える（「約2730」など） */
  override: string | null;
}

export type Shape =
  | LineShape
  | PolylineShape
  | ArcShape
  | CircleShape
  | TextShape
  | PointShape
  | DimensionShape;
export type ShapeKind = Shape['shape'];

/**
 * id・画層・階・属性を除いた図形。図形を組み立てる側（プリセット・DXF 取り込み）が使う。
 * `Omit<Shape, ...>` は共用体にそのまま掛けると各枝に分配されないので、
 * 明示的に分配してから Omit する。
 */
export type ShapeBody = {
  [K in ShapeKind]: Omit<Extract<Shape, { shape: K }>, 'id' | 'layerId' | 'levelId' | 'attrs'>;
}[ShapeKind];

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
  /**
   * アフィン変換を適用した新しい図形を返す（元は変更しない）。
   * nodeMap は複写のときだけ渡る。壁の角に紐づいた寸法の付け替えに使う
   */
  transform(scene: Scene, s: S, t: Transform, nodeMap: Map<Id, Id> | null): S;
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
    transform: (_scene, s, t) => ({ ...s, a: applyPoint(t, s.a), b: applyPoint(t, s.b) }),
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
    transform: (_scene, s, t) => ({ ...s, points: s.points.map((p) => applyPoint(t, p)) }),
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
    transform: (_scene, s, t) => {
      const start = directionAngleAfter(t, s.startAngle);
      const end = directionAngleAfter(t, s.endAngle);
      // 鏡像では掃く向きが逆になる。「常に反時計回り」を保つため始点と終点を入れ替える
      return isMirror(t)
        ? { ...s, center: applyPoint(t, s.center), startAngle: end, endAngle: start }
        : { ...s, center: applyPoint(t, s.center), startAngle: start, endAngle: end };
    },
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
    transform: (_scene, s, t) => ({ ...s, center: applyPoint(t, s.center) }),
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
    // 文字は鏡像にしない。CAD の慣例で、鏡像コマンドでも文字は読める向きに保つ
    transform: (_scene, s, t) => ({ ...s, at: applyPoint(t, s.at), angle: directionAngleAfter(t, s.angle) }),
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
    transform: (_scene, s, t) => ({ ...s, at: applyPoint(t, s.at) }),
  },

  dimension: {
    label: '寸法',
    defaultLayer: LAYER_IDS.dimension,
    pickPriority: 2,
    vertices: (scene, s) => {
      const g = dimensionGeometry(scene, s, scene.standard);
      return g ? [g.a, g.b, g.line.a, g.line.b] : [];
    },
    outline: (scene, s) => {
      const g = dimensionGeometry(scene, s, scene.standard);
      return g ? [g.line, ...g.extensions] : [];
    },
    snapPoints: (scene, s) => {
      const g = dimensionGeometry(scene, s, scene.standard);
      if (!g) return [];
      return [
        { point: g.a, kind: 'node' },
        { point: g.b, kind: 'node' },
        { point: mid(g.line.a, g.line.b), kind: 'midpoint' },
      ];
    },
    primitives: (scene, s, std) => dimensionPrimitives(scene, s, std),
    transform: (scene, s, t, nodeMap) => ({
      ...s,
      a: transformDimEnd(scene, s.a, t, nodeMap),
      b: transformDimEnd(scene, s.b, t, nodeMap),
      // 鏡像では法線の向きが反転するので、出す側を入れ替える
      offset: isMirror(t) ? -s.offset : s.offset,
    }),
  },
};

/**
 * 寸法の端点を変換する。
 * 複写のときは紐づくノードを複製側へ付け替え、対応が無ければ自由点に落とす
 * （さもないとコピーが元の壁を測り続けてしまう）。
 */
function transformDimEnd(scene: Scene, end: DimEnd, t: Transform, nodeMap: Map<Id, Id> | null): DimEnd {
  const p = applyPoint(t, dimEndPoint(scene, end));
  if (!end.nodeId) return { x: p.x, y: p.y, nodeId: null };
  if (!nodeMap) return { ...end, x: p.x, y: p.y };
  const mapped = nodeMap.get(end.nodeId);
  return mapped ? { x: p.x, y: p.y, nodeId: mapped } : { x: p.x, y: p.y, nodeId: null };
}

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
export function transformShape(
  scene: Scene,
  s: Shape,
  t: Transform,
  nodeMap: Map<Id, Id> | null = null,
): Shape {
  return SHAPE_GEOMETRY[s.shape].transform(scene, s as never, t, nodeMap);
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
export function arcFromPoints(center: Vec, from: Vec, to: Vec): Omit<ArcShape, 'id' | 'layerId' | 'levelId' | 'attrs' | 'shape'> {
  return {
    center,
    radius: dist(center, from),
    startAngle: angleOf({ x: from.x - center.x, y: from.y - center.y }),
    endAngle: angleOf({ x: to.x - center.x, y: to.y - center.y }),
  };
}

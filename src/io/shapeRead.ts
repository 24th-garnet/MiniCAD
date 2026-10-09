import { vec, type Vec } from '../core/geometry.ts';
import type { LayerId } from '../core/layer.ts';
import type { Shape, ShapeKind } from '../core/shapes.ts';
import type { Id } from '../core/types.ts';

type Raw = Record<string, unknown>;
type Reader<K extends ShapeKind> = (id: Id, raw: Raw, layerId: LayerId) => Extract<Shape, { shape: K }> | null;

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function point(v: unknown): Vec | null {
  if (typeof v !== 'object' || v === null) return null;
  const p = v as Raw;
  if (typeof p.x !== 'number' || typeof p.y !== 'number') return null;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return vec(p.x, p.y);
}

function points(v: unknown): Vec[] {
  if (!Array.isArray(v)) return [];
  return v.map(point).filter((p): p is Vec => p !== null);
}

const ALIGNS = ['left', 'center', 'right'] as const;
const align = (v: unknown): (typeof ALIGNS)[number] =>
  ALIGNS.includes(v as (typeof ALIGNS)[number]) ? (v as (typeof ALIGNS)[number]) : 'center';

/**
 * 図形の読み取り。
 * 種別を足すとここが型エラーになるので、保存だけできて読めない、という事故を防げる。
 */
export const SHAPE_READERS: { [K in ShapeKind]: Reader<K> } = {
  line: (id, raw, layerId) => {
    const a = point(raw.a);
    const b = point(raw.b);
    return a && b ? { id, shape: 'line', layerId, a, b } : null;
  },

  polyline: (id, raw, layerId) => {
    const pts = points(raw.points);
    return pts.length >= 2 ? { id, shape: 'polyline', layerId, points: pts, closed: raw.closed === true } : null;
  },

  arc: (id, raw, layerId) => {
    const center = point(raw.center);
    const radius = num(raw.radius, 0);
    if (!center || radius <= 0) return null;
    return {
      id,
      shape: 'arc',
      layerId,
      center,
      radius,
      startAngle: num(raw.startAngle, 0),
      endAngle: num(raw.endAngle, Math.PI / 2),
    };
  },

  circle: (id, raw, layerId) => {
    const center = point(raw.center);
    const radius = num(raw.radius, 0);
    return center && radius > 0 ? { id, shape: 'circle', layerId, center, radius } : null;
  },

  text: (id, raw, layerId) => {
    const at = point(raw.at);
    if (!at || typeof raw.text !== 'string') return null;
    return {
      id,
      shape: 'text',
      layerId,
      at,
      text: raw.text,
      height: num(raw.height, 3.5),
      angle: num(raw.angle, 0),
      align: align(raw.align),
    };
  },

  point: (id, raw, layerId) => {
    const at = point(raw.at);
    return at ? { id, shape: 'point', layerId, at } : null;
  },

  dimension: (id, raw, layerId) => {
    const a = dimEnd(raw.a);
    const b = dimEnd(raw.b);
    if (!a || !b) return null;
    return {
      id,
      shape: 'dimension',
      layerId,
      a,
      b,
      offset: num(raw.offset, 0),
      override: typeof raw.override === 'string' ? raw.override : null,
    };
  },
};

function dimEnd(v: unknown): { x: number; y: number; nodeId: Id | null } | null {
  const p = point(v);
  if (!p) return null;
  const nodeId = (v as Raw).nodeId;
  return { x: p.x, y: p.y, nodeId: typeof nodeId === 'string' ? nodeId : null };
}

/** 知らない種別は黙って捨てる（外から来た JSON を信用しない、という既存の方針） */
export function readShape(id: Id, raw: unknown, layerId: LayerId): Shape | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Raw;
  const kind = obj.shape;
  if (typeof kind !== 'string' || !(kind in SHAPE_READERS)) return null;
  return SHAPE_READERS[kind as ShapeKind](id, obj, layerId);
}

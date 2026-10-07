/**
 * 2D幾何ユーティリティ。
 * ワールド座標は mm 単位・y軸上向き（建築図面の流儀）。画面への y 反転は viewport が担う。
 */

export interface Vec {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const lenSq = (a: Vec): number => a.x * a.x + a.y * a.y;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(b.x - a.x, b.y - a.y);
export const distSq = (a: Vec, b: Vec): number => lenSq(sub(b, a));
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const mid = (a: Vec, b: Vec): Vec => lerp(a, b, 0.5);

export function norm(a: Vec): Vec {
  const l = len(a);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** 反時計回りに90度回した法線 */
export const perp = (a: Vec): Vec => ({ x: -a.y, y: a.x });

export function rotate(a: Vec, angle: number): Vec {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

/** x軸からの角度（ラジアン、-PI..PI） */
export const angleOf = (a: Vec): number => Math.atan2(a.y, a.x);

/** 0..2PI に正規化 */
export function normalizeAngle(a: number): number {
  const t = a % (Math.PI * 2);
  return t < 0 ? t + Math.PI * 2 : t;
}

export const toDeg = (rad: number): number => (rad * 180) / Math.PI;
export const toRad = (deg: number): number => (deg * Math.PI) / 180;

export interface ClosestResult {
  point: Vec;
  /** 線分上のパラメータ 0..1 */
  t: number;
  dist: number;
}

/** 点 p に最も近い線分 ab 上の点 */
export function closestOnSegment(p: Vec, a: Vec, b: Vec): ClosestResult {
  const ab = sub(b, a);
  const l2 = lenSq(ab);
  if (l2 < 1e-12) return { point: { ...a }, t: 0, dist: dist(p, a) };
  let t = dot(sub(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  const point = add(a, mul(ab, t));
  return { point, t, dist: dist(p, point) };
}

/** 線分 ab と線分 cd の交点。平行・非交差なら null */
export function segmentIntersection(a: Vec, b: Vec, c: Vec, d: Vec): Vec | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-12) return null;
  const t = cross(sub(c, a), s) / denom;
  const u = cross(sub(c, a), r) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return add(a, mul(r, t));
}

/** 符号付き面積。y軸上向きの世界で反時計回りなら正 */
export function signedArea(pts: Vec[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

export function centroid(pts: Vec[]): Vec {
  const a = signedArea(pts);
  if (Math.abs(a) < 1e-9) {
    // 退化ポリゴンは単純平均で代用
    const sum = pts.reduce((acc, p) => add(acc, p), vec(0, 0));
    return mul(sum, 1 / Math.max(1, pts.length));
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function pointInPolygon(p: Vec, pts: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export interface Bounds {
  min: Vec;
  max: Vec;
}

export function boundsOf(pts: Vec[]): Bounds | null {
  if (pts.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { min: vec(minX, minY), max: vec(maxX, maxY) };
}

/** 回転した矩形の4隅（中心・サイズ・角度から） */
export function rectCorners(center: Vec, w: number, h: number, angle: number): Vec[] {
  const hw = w / 2;
  const hh = h / 2;
  return [vec(-hw, -hh), vec(hw, -hh), vec(hw, hh), vec(-hw, hh)].map((p) => add(center, rotate(p, angle)));
}

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

export const EPS = 1e-9;

/** 無限直線としての交点。t / u は各直線上のパラメータで、0..1 の外も返す */
export interface LineHit {
  point: Vec;
  t: number;
  u: number;
}

/**
 * 直線 ab と直線 cd の交点。
 * `segmentIntersection` は線分に限るので、延長やトリムには使えない。
 */
export function lineLineIntersection(a: Vec, b: Vec, c: Vec, d: Vec): LineHit | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = cross(r, s);
  // ほぼ平行なら交点は求めない（遠くに飛んだ点を返しても使い道がない）。
  // |cross| / (|r||s|) は2直線のなす角の sin なので、長さに依らない判定になる
  if (Math.abs(denom) <= EPS * len(r) * len(s)) return null;
  const t = cross(sub(c, a), s) / denom;
  const u = cross(sub(c, a), r) / denom;
  return { point: add(a, mul(r, t)), t, u };
}

/** 円弧。start から end へ**常に反時計回り**、という不変条件を持つ */
export interface Arc {
  center: Vec;
  radius: number;
  start: number;
  end: number;
}

/** 掃き角。始点と終点が一致していれば全周とみなす */
export function arcSweepAngle(arc: Arc): number {
  const sweep = normalizeAngle(arc.end - arc.start);
  return sweep < EPS ? Math.PI * 2 : sweep;
}

/**
 * その角度が円弧の範囲に入っているか。
 * ±π の継ぎ目をまたぐ円弧（170° → -170° など）でも正しく判定する。
 * ここを素朴に `start <= angle <= end` と書くと必ず壊れる。
 */
export function arcContainsAngle(arc: Arc, angle: number): boolean {
  return normalizeAngle(angle - arc.start) <= arcSweepAngle(arc) + EPS;
}

export function arcPoint(arc: Arc, angle: number): Vec {
  return add(arc.center, vec(Math.cos(angle) * arc.radius, Math.sin(angle) * arc.radius));
}

/** 直線 ab と円の交点。接する場合は1点だけ返す */
export function lineCircleIntersection(a: Vec, b: Vec, center: Vec, radius: number): { point: Vec; t: number }[] {
  const d = sub(b, a);
  const f = sub(a, center);
  const A = lenSq(d);
  if (A < 1e-12) return [];
  const B = 2 * dot(f, d);
  const C = lenSq(f) - radius * radius;
  const disc = B * B - 4 * A * C;
  if (disc < -1e-9) return [];
  if (disc < 1e-9) {
    const t = -B / (2 * A);
    return [{ point: add(a, mul(d, t)), t }];
  }
  const root = Math.sqrt(disc);
  return [(-B - root) / (2 * A), (-B + root) / (2 * A)].map((t) => ({ point: add(a, mul(d, t)), t }));
}

export function circleCircleIntersection(c1: Vec, r1: number, c2: Vec, r2: number): Vec[] {
  const d = dist(c1, c2);
  if (d < 1e-9 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const hSq = r1 * r1 - a * a;
  const base = add(c1, mul(norm(sub(c2, c1)), a));
  if (hSq < 1e-9) return [base];
  const h = Math.sqrt(hSq);
  const offset = mul(perp(norm(sub(c2, c1))), h);
  return [add(base, offset), sub(base, offset)];
}

/** 線分を進行方向の左へ d だけ寄せる（d が負なら右） */
export function offsetSegment(a: Vec, b: Vec, d: number): [Vec, Vec] {
  const n = mul(perp(norm(sub(b, a))), d);
  return [add(a, n), add(b, n)];
}

/**
 * ポリラインのオフセット。
 * 各辺を平行移動し、隣り合う辺の**無限直線**の交点を新しい角にする（マイター）。
 * 自己交差の除去はしない。退化したら null を返して潔く諦める。
 * 本格的な CAD のオフセット（ループ除去つき）とは別物だと割り切っている。
 */
export function offsetPolyline(points: Vec[], d: number, closed: boolean): Vec[] | null {
  if (points.length < 2) return null;
  const edges: { a: Vec; b: Vec }[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    if (dist(points[i], points[i + 1]) < 1e-9) return null;
    const [a, b] = offsetSegment(points[i], points[i + 1], d);
    edges.push({ a, b });
  }
  if (closed) {
    if (dist(points[points.length - 1], points[0]) < 1e-9) return null;
    const [a, b] = offsetSegment(points[points.length - 1], points[0], d);
    edges.push({ a, b });
  }

  const out: Vec[] = [];
  for (let i = 0; i < points.length; i++) {
    const incoming = closed ? edges[(i - 1 + edges.length) % edges.length] : edges[i - 1];
    const outgoing = closed ? edges[i % edges.length] : edges[i];
    if (!incoming) {
      out.push(outgoing.a);
      continue;
    }
    if (!outgoing) {
      out.push(incoming.b);
      continue;
    }
    const hit = lineLineIntersection(incoming.a, incoming.b, outgoing.a, outgoing.b);
    // 平行な2辺（直線が続いているだけ）は交点が出ないので、そのまま繋ぐ
    out.push(hit ? hit.point : outgoing.a);
  }
  return out;
}

/** 点が直線のどちら側か。オフセットの向きを決めるのに使う */
export function sideOfLine(a: Vec, b: Vec, p: Vec): 1 | -1 {
  return cross(sub(b, a), sub(p, a)) >= 0 ? 1 : -1;
}

/**
 * 点を直線 ab に射影したときのパラメータ。クランプしない。
 * `closestOnSegment` は 0..1 に丸めるので、延長の判定には使えない。
 */
export function projectParam(a: Vec, b: Vec, p: Vec): number {
  const d = sub(b, a);
  const l2 = lenSq(d);
  return l2 < 1e-12 ? 0 : dot(sub(p, a), d) / l2;
}

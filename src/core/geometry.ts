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
export const dist = (a: Vec, b: Vec): number =>
  Math.hypot(b.x - a.x, b.y - a.y);
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export const mid = (a: Vec, b: Vec): Vec => lerp(a, b, 0.5);

export function norm(a: Vec): Vec {
  const l = len(a);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** 反時計回りに90度回した法線 */
export const perp = (a: Vec): Vec => ({ x: -a.y, y: a.x });

/**
 * 3D の点の、いちばん小さい形。
 *
 * **`render3d/` の `Vec3` とは別に持つ。** `core/` は描画を知らない規則で、
 * `render3d/mat4.ts` を呼ぶと依存の向きが逆になる。欄は同じ 3 つなので、
 * `render3d/` 側はそのまま受け取れる。`core/push.ts` が同じ理由で
 * 先に置いていたものを、ここへ移した。
 */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export const vec3Like = (x: number, y: number, z: number): Vec3Like => ({
  x,
  y,
  z,
});

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
export function segmentIntersection(
  a: Vec,
  b: Vec,
  c: Vec,
  d: Vec,
): Vec | null {
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
/**
 * 多角形の角を落とす。**面取り（直線 1 本）か、丸め（円弧）。**
 *
 * **角柱の縦の稜線は、平面の輪郭の頂点そのもの。** だから縦の面取り・丸めは
 * 3D の問題ではなく 2D の問題で、ここで落とせば**平面の記号にも 3D にも
 * 同時に効く**（`insetOutline` が上下の稜線でやっているのと同じ考え方を、
 * もう 1 つの軸でやる）。
 *
 * - `chamfer` は辺に沿って `size` ずつ戻した 2 点を結ぶ
 * - `fillet` は `size` を**半径**として、両辺に接する円弧を入れる
 *
 * **行きすぎは隣の辺の半分で止める。** 止めないと辺が裏返って、
 * 面積が負の多角形になる。まっすぐな頂点（曲がりが小さい）は触らない。
 */
export function cutCorners(
  poly: readonly Vec[],
  kind: "chamfer" | "fillet",
  size: number,
): Vec[] {
  if (!(size > 0) || poly.length < 3) return [...poly];
  const n = poly.length;
  const out: Vec[] = [];

  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const cur = poly[i];
    const next = poly[(i + 1) % n];
    const toPrev = sub(prev, cur);
    const toNext = sub(next, cur);
    const lenPrev = len(toPrev);
    const lenNext = len(toNext);
    if (lenPrev < EPS || lenNext < EPS) {
      out.push(cur);
      continue;
    }
    const d1 = mul(toPrev, 1 / lenPrev);
    const d2 = mul(toNext, 1 / lenNext);
    // 頂点での開き。π に近ければ「まっすぐ」なので触らない
    const open = Math.acos(Math.max(-1, Math.min(1, dot(d1, d2))));
    if (open > Math.PI - CORNER_EPS || open < CORNER_EPS) {
      out.push(cur);
      continue;
    }
    const half = open / 2;
    const want = kind === "chamfer" ? size : size / Math.tan(half);
    const t = Math.min(want, lenPrev / 2, lenNext / 2);
    if (t < EPS) {
      out.push(cur);
      continue;
    }
    const a = add(cur, mul(d1, t));
    const b = add(cur, mul(d2, t));
    if (kind === "chamfer") {
      out.push(a, b);
      continue;
    }
    // 丸め。中心は二等分線の上、頂点から t / cos(half)
    const bisect = norm(add(d1, d2));
    const radius = t * Math.tan(half);
    const center = add(cur, mul(bisect, t / Math.cos(half)));
    const from = angleOf(sub(a, center));
    const to = angleOf(sub(b, center));
    // 短いほうへ回る。頂点をまたがない側が外へ膨らまない
    let sweep = normalizeAngle(to - from);
    if (sweep > Math.PI) sweep -= Math.PI * 2;
    out.push(...arcPolyline(center, radius, from, sweep));
  }
  return out;
}

/** これより小さい曲がりは「まっすぐ」とみなす（ラジアン） */
const CORNER_EPS = 1e-6;

/**
 * 凸包（単調連鎖）。**反時計回りで返す。**
 *
 * 傾いた立体を上から見た形に使う。本当の輪郭は凹むことも自己交差することも
 * あるが、拾う処理（`pointInPolygon`）・面積（`signedArea`）・図面の範囲は
 * **単純多角形であること**に寄りかかっている。凸包なら倒しても単純なまま。
 *
 * **実物より少し広く出る**（凹んだ部分も包む）。そう割り切ったうえで使う。
 */
export function convexHull(points: readonly Vec[]): Vec[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const uniq: Vec[] = [];
  for (const p of sorted) {
    const last = uniq[uniq.length - 1];
    if (!last || dist(last, p) > 1e-9) uniq.push(p);
  }
  if (uniq.length < 3) return uniq;

  // 左へ曲がらない点を捨てながら積む。これを往復させると凸包になる
  const half = (src: Vec[]): Vec[] => {
    const out: Vec[] = [];
    for (const p of src) {
      while (out.length >= 2) {
        const a = out[out.length - 2];
        const b = out[out.length - 1];
        if (cross(sub(b, a), sub(p, a)) > 1e-12) break;
        out.pop();
      }
      out.push(p);
    }
    return out;
  };
  const lower = half(uniq);
  const upper = half([...uniq].reverse());
  // 両端は次の半分の先頭と重なるので落とす
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

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
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
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
export function lineLineIntersection(
  a: Vec,
  b: Vec,
  c: Vec,
  d: Vec,
): LineHit | null {
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

/** 直線 ab と円の交点。接する場合は1点だけ返す */
export function lineCircleIntersection(
  a: Vec,
  b: Vec,
  center: Vec,
  radius: number,
): { point: Vec; t: number }[] {
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
  return [(-B - root) / (2 * A), (-B + root) / (2 * A)].map((t) => ({
    point: add(a, mul(d, t)),
    t,
  }));
}

export function circleCircleIntersection(
  c1: Vec,
  r1: number,
  c2: Vec,
  r2: number,
): Vec[] {
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
export function offsetPolyline(
  points: Vec[],
  d: number,
  closed: boolean,
): Vec[] | null {
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
    const incoming = closed
      ? edges[(i - 1 + edges.length) % edges.length]
      : edges[i - 1];
    const outgoing = closed ? edges[i % edges.length] : edges[i];
    if (!incoming) {
      out.push(outgoing.a);
      continue;
    }
    if (!outgoing) {
      out.push(incoming.b);
      continue;
    }
    const hit = lineLineIntersection(
      incoming.a,
      incoming.b,
      outgoing.a,
      outgoing.b,
    );
    // 平行な2辺（直線が続いているだけ）は交点が出ないので、そのまま繋ぐ
    out.push(hit ? hit.point : outgoing.a);
  }
  return out;
}

/** 点が直線のどちら側か。オフセットの向きを決めるのに使う */
/**
 * 円弧を折れ線に分割するときの最大の刻み（ラジアン）。約 11.25 度。
 *
 * **ここが唯一の出どころ。** 以前は `core/shapes.ts` と `io/dxfImport.ts` に
 * 同じ値が 1 つずつあり、片方を直すと図形と取り込みで滑らかさが食い違った。
 */
export const ARC_STEP = Math.PI / 16;

/** 中心・半径・角度から円周上の点 */
export function arcPointAt(center: Vec, radius: number, angle: number): Vec {
  return add(center, vec(Math.cos(angle) * radius, Math.sin(angle) * radius));
}

/** 円弧を折れ線に。`sweep` は符号つきで、負なら時計回り */
export function arcPolyline(
  center: Vec,
  radius: number,
  start: number,
  sweep: number,
): Vec[] {
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / ARC_STEP));
  const points: Vec[] = [];
  for (let i = 0; i <= steps; i++) {
    points.push(arcPointAt(center, radius, start + (sweep * i) / steps));
  }
  return points;
}

/**
 * 楕円の弧を折れ線に。`major` は長半径、`ratio` は短半径 / 長半径、
 * `tilt` は長軸の向き。全周のときは最後の点（＝始点と同じ）を落とす。
 *
 * **楕円を表す `Primitive` は無く、R12 DXF にも ELLIPSE が無い。**
 * 画面も SVG も DXF も折れ線で出すので、ここで一度だけ折る。
 */
export function ellipsePoints(
  center: Vec,
  major: number,
  ratio: number,
  tilt: number,
  startParam = 0,
  sweep = Math.PI * 2,
): Vec[] {
  const full = Math.abs(sweep) >= Math.PI * 2 - 1e-6;
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / ARC_STEP));
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const points: Vec[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = startParam + (sweep * i) / steps;
    const x = major * Math.cos(a);
    const y = major * ratio * Math.sin(a);
    points.push(
      vec(center.x + x * cos - y * sin, center.y + x * sin + y * cos),
    );
  }
  if (full) points.pop();
  return points;
}

/**
 * 3 点を通る円の中心。一直線に並んでいれば null。
 *
 * 2 本の弦の垂直二等分線の交点。`lineLineIntersection` が無限直線どうしの
 * 交点を返すので、そこへ投げるだけで済む。
 */
export function circleThrough(
  a: Vec,
  b: Vec,
  c: Vec,
): { center: Vec; radius: number } | null {
  const m1 = mid(a, b);
  const m2 = mid(b, c);
  const n1 = perp(sub(b, a));
  const n2 = perp(sub(c, b));
  const hit = lineLineIntersection(m1, add(m1, n1), m2, add(m2, n2));
  if (!hit) return null;
  return { center: hit.point, radius: dist(hit.point, a) };
}

/**
 * 2 点を通り、半径が決まった円の中心。2 つあるうち `left` が真なら
 * 進行方向の左側を返す。半径が足りなければ null。
 */
export function centerFromChord(
  a: Vec,
  b: Vec,
  radius: number,
  left: boolean,
): Vec | null {
  const half = dist(a, b) / 2;
  if (half < 1e-9 || radius < half) return null;
  const out = Math.sqrt(Math.max(0, radius * radius - half * half));
  const n = perp(norm(sub(b, a)));
  return add(mid(a, b), mul(n, left ? out : -out));
}

/** 正多角形の頂点。`angle` は最初の頂点の向き */
export function regularPolygonPoints(
  center: Vec,
  radius: number,
  sides: number,
  angle: number,
): Vec[] {
  const n = Math.max(3, Math.round(sides));
  const out: Vec[] = [];
  for (let i = 0; i < n; i++)
    out.push(arcPointAt(center, radius, angle + (Math.PI * 2 * i) / n));
  return out;
}

/**
 * 対角の 2 点から四角形の 4 隅（反時計回りではなく、打った順に沿う並び）。
 * 潰れていれば null——幅か高さが 1mm 未満の「四角形」は図形として意味がない。
 */
export function rectFromDiagonal(a: Vec, b: Vec): Vec[] | null {
  if (Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1) return null;
  return [a, vec(b.x, a.y), b, vec(a.x, b.y)];
}

/** 自由曲線の滑らかさ。制御点 1 区間あたりの分割数 */
export const SPLINE_STEPS = 12;

/**
 * Catmull-Rom で制御点をなめらかに繋ぐ。両端は折り返して接線を作る。
 *
 * **制御点そのものを通る。** ベジエの制御点と違って「引っぱられる」位置が無いので、
 * 打った点の上を通る曲線になり、描いている最中の見た目と結果が一致する。
 *
 * 曲線そのものを持つ型は作らない。`Primitive` に曲線が無く、R12 DXF にも
 * SPLINE が無いので、どのみち折れ線で出すことになる。
 */
export function splinePoints(control: Vec[]): Vec[] {
  if (control.length < 3) return control;
  const at = (i: number): Vec =>
    control[Math.max(0, Math.min(control.length - 1, i))];
  const out: Vec[] = [control[0]];
  for (let i = 0; i < control.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let k = 1; k <= SPLINE_STEPS; k++) {
      const t = k / SPLINE_STEPS;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (w: number, x: number, y: number, z: number): number =>
        0.5 *
        (2 * x +
          (y - w) * t +
          (2 * w - 5 * x + 4 * y - z) * t2 +
          (-w + 3 * x - 3 * y + z) * t3);
      out.push(vec(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y)));
    }
  }
  return out;
}

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

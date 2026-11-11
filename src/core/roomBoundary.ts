import {
  add,
  angleOf,
  arcPolyline,
  circleCircleIntersection,
  cross,
  dist,
  lineCircleIntersection,
  lineLineIntersection,
  mul,
  norm,
  perp,
  pointOnBulgeArc,
  signedArea,
  sub,
  type BulgeArc,
  type Vec,
} from './geometry.ts';

/**
 * 部屋の境界を、直線と円弧の列として持つ。
 *
 * **折れ線にしてから測らない。** 円弧壁を短い直線の連なりに潰すと、面積も
 * 周長も刻み幅ぶんだけ必ず小さく出る。半径 3000 を 11.25 度で割った折れ線は
 * 本物の円弧より 0.1% ほど内側を通り、**積算にそのまま乗る**。
 * 画面と当たり判定には折れ線を渡し（`toPolyline`）、**数字は閉じた式で出す**
 * （`boundaryArea` / `boundaryPerimeter`）。
 *
 * 円弧は「中心と半径」ではなく、**辺として進む向きの `BulgeArc`** を持つ。
 * `pointOnBulgeArc(arc, 0)` が `a`、`1` が `b` になる向きに揃えてある。
 */
export type BoundaryEdge =
  | { kind: 'line'; a: Vec; b: Vec }
  | { kind: 'arc'; a: Vec; b: Vec; arc: BulgeArc };

/** 画面と当たり判定のための折れ線。円弧だけが点に割られる */
export function toPolyline(edges: BoundaryEdge[]): Vec[] {
  const out: Vec[] = [];
  for (const e of edges) {
    out.push({ ...e.a });
    if (e.kind !== 'arc') continue;
    // 始点と終点は辺の端点が持つので、中の点だけを足す
    const pts = arcPolyline(e.arc.center, e.arc.radius, e.arc.from, e.arc.sweep);
    for (let i = 1; i < pts.length - 1; i++) out.push(pts[i]);
  }
  return out;
}

/**
 * 符号つき面積。**閉じた式で、近似を一切しない。**
 *
 * 弦でできた多角形の面積に、円弧ごとの弓形の面積 `(R²/2)(s − sin s)` を
 * 足す。導出は線積分 `∮(x dy − y dx)/2` を円弧について解いたもので、
 * 弦の寄与を引くと中心の位置が消え、半径と掃過角だけが残る。
 *
 * 符号は掃過角が持つ。優弧（|s| > π）でも `s − sin s` がそのまま効くので、
 * 場合分けは要らない。
 */
export function boundaryArea(edges: BoundaryEdge[]): number {
  let area = signedArea(edges.map((e) => e.a));
  for (const e of edges) {
    if (e.kind !== 'arc') continue;
    const { radius: r, sweep: s } = e.arc;
    area += ((r * r) / 2) * (s - Math.sin(s));
  }
  return area;
}

/** 周長。円弧は弧長（半径 × 掃過角）で、弦ではない */
export function boundaryPerimeter(edges: BoundaryEdge[]): number {
  let total = 0;
  for (const e of edges) {
    total += e.kind === 'arc' ? e.arc.radius * Math.abs(e.arc.sweep) : dist(e.a, e.b);
  }
  return total;
}

/**
 * 反時計回りの境界を、内側（進行方向の左）へ厚さの半分だけ寄せる。
 *
 * **円弧は同心円弧になる。** 中心が左にある（掃過角が正）なら内側へ寄せると
 * 半径が縮み、右にあるなら伸びる —— `R − sign(sweep)·t/2` の 1 行で両方が出る。
 * 折れ線に潰してから寄せると、角が丸まって内法が小さく出る。
 *
 * 角は、隣り合う寄せた曲線の交点で決める。交わらない（平行・接する）ときは
 * 寄せた端点をそのまま使う —— 直線だけのときの振る舞いと同じ。
 */
export function offsetInward(edges: BoundaryEdge[], thicknesses: number[]): BoundaryEdge[] {
  const n = edges.length;
  if (n === 0) return [];
  const moved = edges.map((e, i) => offsetEdge(e, (thicknesses[i] ?? 0) / 2));

  const out: BoundaryEdge[] = [];
  for (let i = 0; i < n; i++) {
    const prev = moved[(i - 1 + n) % n];
    const curr = moved[i];
    // 角は「元の角のいちばん近く」を採る。円どうしは交点が 2 つ出る
    const corner = cornerOf(prev, curr, edges[i].a) ?? curr.a;
    const next = moved[(i + 1) % n];
    const end = cornerOf(curr, next, edges[(i + 1) % n].a) ?? curr.b;
    out.push(reEnd(curr, corner, end));
  }
  return out;
}

/** 1 辺を内側へ。直線は平行移動、円弧は同心 */
function offsetEdge(e: BoundaryEdge, half: number): BoundaryEdge {
  if (e.kind === 'line') {
    const d = norm(sub(e.b, e.a));
    const inward = mul(perp(d), half);
    return { kind: 'line', a: add(e.a, inward), b: add(e.b, inward) };
  }
  const sign = e.arc.sweep >= 0 ? 1 : -1;
  const radius = e.arc.radius - sign * half;
  if (!(radius > 1e-6)) return e; // 厚さが半径を食い切る。寄せない
  const arc: BulgeArc = { ...e.arc, radius };
  return { kind: 'arc', a: pointOnBulgeArc(arc, 0), b: pointOnBulgeArc(arc, 1), arc };
}

/** 隣り合う 2 辺の交点のうち、元の角にいちばん近いもの */
function cornerOf(prev: BoundaryEdge, curr: BoundaryEdge, near: Vec): Vec | null {
  const hits = intersectionsOf(prev, curr);
  if (hits.length === 0) return null;
  return hits.reduce((best, p) => (dist(p, near) < dist(best, near) ? p : best));
}

/** 辺を無限に伸ばした（直線は直線、円弧は円）ときの交点 */
function intersectionsOf(x: BoundaryEdge, y: BoundaryEdge): Vec[] {
  if (x.kind === 'line' && y.kind === 'line') {
    // 平行なら交わらない。`lineLineIntersection` が null を返す
    const hit = lineLineIntersection(x.a, x.b, y.a, y.b);
    return hit ? [hit.point] : [];
  }
  if (x.kind === 'line') {
    const c = (y as { arc: BulgeArc }).arc;
    return lineCircleIntersection(x.a, x.b, c.center, c.radius).map((h) => h.point);
  }
  if (y.kind === 'line') {
    const c = (x as { arc: BulgeArc }).arc;
    return lineCircleIntersection(y.a, y.b, c.center, c.radius).map((h) => h.point);
  }
  return circleCircleIntersection(x.arc.center, x.arc.radius, y.arc.center, y.arc.radius);
}

/**
 * 端点を角に合わせ直す。
 *
 * 円弧は**掃過角をずらした分だけ動かす**。端点の角度から引き直すと、
 * 優弧（|s| > π）が劣弧に化ける —— 角度の差は ±π に畳まれるので、
 * 「どちら回りに何周したか」が失われる。角はごくわずかしか動かないので、
 * ずれの分だけ足し引きすれば向きも優弧かどうかも保たれる。
 */
function reEnd(e: BoundaryEdge, a: Vec, b: Vec): BoundaryEdge {
  if (e.kind === 'line') return { kind: 'line', a, b };
  const c = e.arc.center;
  const da = signedDelta(angleOf(sub(a, c)) - e.arc.from);
  const db = signedDelta(angleOf(sub(b, c)) - (e.arc.from + e.arc.sweep));
  const arc: BulgeArc = { ...e.arc, from: e.arc.from + da, sweep: e.arc.sweep - da + db };
  return { kind: 'arc', a, b, arc };
}

/** −π〜π に畳む */
function signedDelta(angle: number): number {
  let v = angle % (Math.PI * 2);
  if (v > Math.PI) v -= Math.PI * 2;
  if (v < -Math.PI) v += Math.PI * 2;
  return v;
}

/**
 * 辺を進み始めるときの向き（単位）と、曲がり方。
 *
 * **節点の周りで辺を並べるのに使う。** 弦の向きで並べると、円弧壁が
 * 節点から出てゆく実際の向きと食い違い、面の辿りが隣の辺へ逸れる。
 * 接線が同じ 2 辺（円弧に接する直線）は、**左へ曲がるほうを後に**置く
 * —— 反時計回りの並びでは、曲がった先の角度が大きいほうが後になる。
 */
export function departure(a: Vec, b: Vec, arc: BulgeArc | null): { angle: number; turn: number } {
  if (!arc) return { angle: halfTurn(angleOf(sub(b, a))), turn: 0 };
  const sign = arc.sweep >= 0 ? 1 : -1;
  // 接線は半径を ±90 度。反時計回りなら左、時計回りなら右
  const radial = angleOf(sub(a, arc.center));
  return { angle: halfTurn(radial + (sign * Math.PI) / 2), turn: sign / arc.radius };
}

/**
 * −π 以上 π 未満に畳む。**直線も円弧も必ずここを通す。**
 *
 * `angleOf` は (−π, π] を返すので、円弧の接線（半径 ±90 度）をそのまま
 * 使うと 3π/2 のような値が混ざり、**同じ向きの辺が別の数になって**
 * 節点の周りの並びが狂う。畳み方を 1 つに揃えれば、どちらも同じ数になる。
 */
function halfTurn(angle: number): number {
  let v = angle % (Math.PI * 2);
  if (v >= Math.PI) v -= Math.PI * 2;
  if (v < -Math.PI) v += Math.PI * 2;
  return v;
}

/** 一直線に並んだ 3 点か（角の丸め判定に使う） */
export const collinear = (a: Vec, b: Vec, c: Vec): boolean =>
  Math.abs(cross(sub(b, a), sub(c, b))) < 1e-6;

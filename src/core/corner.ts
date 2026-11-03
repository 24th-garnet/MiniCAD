import { add, angleOf, dist, lineLineIntersection, mul, norm, sub, type Vec } from './geometry.ts';
import { curveToShape, shapeCurves, wallCurve } from './modify.ts';
import { addWall, findOrCreateNode, wallEnds } from './ops.ts';
import type { EntityRef, Scene } from './types.ts';
import type { Curve } from './modify.ts';

/**
 * 角の処理（面取り・角の丸め）。
 *
 * **`Curve` 層に書く。** そうすれば図形にも壁にも同じものが効く
 * （`shapeCurves` / `wallCurve` が両方をここへ落とす）。
 *
 * **線分どうしだけを相手にする。** 円弧や円との面取りは 3×3 の 6 通りの
 * 組み合わせになり、それぞれに接線の場合分けが付く。いま要るのは
 * 「2 本の壁の角を落とす」「2 本の線の角を丸める」で、どちらも線分どうし。
 * 相手が円弧のときは**何もしないと答える**（黙って変なものを作らない）。
 */

export interface CornerResult {
  /** 短くした 2 本。元の順に対応する */
  trimmed: [Curve, Curve];
  /** あいだを埋めるもの。面取りなら線分、角の丸めなら円弧 */
  bridge: Curve;
}

/** 線分の、pick に遠いほうの端（＝残す側）を向きとして取り出す */
function legOf(curve: Curve, corner: Vec): { far: Vec; dir: Vec } | null {
  if (curve.kind !== 'segment') return null;
  // 角から遠いほうの端を残す
  const far = dist(curve.a, corner) >= dist(curve.b, corner) ? curve.a : curve.b;
  const d = sub(corner, far);
  return dist(far, corner) < 1e-9 ? null : { far, dir: norm(d) };
}

/**
 * 2 本の線分が交わる点。線分の外でもよい（延長して角を作る）。
 * 平行なら null。
 */
export function cornerPoint(x: Curve, y: Curve): Vec | null {
  if (x.kind !== 'segment' || y.kind !== 'segment') return null;
  const hit = lineLineIntersection(x.a, x.b, y.a, y.b);
  return hit ? hit.point : null;
}

/**
 * 面取り。角から `d1` / `d2` だけ戻った 2 点を結ぶ。
 * 戻る距離が辺の長さを超えるときは null（辺が消えてしまう）。
 */
export function chamferCurves(x: Curve, y: Curve, d1: number, d2: number): CornerResult | null {
  const corner = cornerPoint(x, y);
  if (!corner) return null;
  const a = legOf(x, corner);
  const b = legOf(y, corner);
  if (!a || !b) return null;
  if (d1 <= 0 || d2 <= 0) return null;
  if (d1 >= dist(a.far, corner) || d2 >= dist(b.far, corner)) return null;

  const p1 = sub(corner, mul(a.dir, d1));
  const p2 = sub(corner, mul(b.dir, d2));
  return {
    trimmed: [
      { kind: 'segment', a: a.far, b: p1 },
      { kind: 'segment', a: b.far, b: p2 },
    ],
    bridge: { kind: 'segment', a: p1, b: p2 },
  };
}

/**
 * 角の丸め。半径 `r` の円を 2 辺に接させ、接点のあいだを円弧で繋ぐ。
 *
 * 接点までの距離は `r / tan(θ/2)`、中心は角から二等分線に沿って
 * `r / sin(θ/2)`。θ は 2 辺のなす角。
 */
export function filletCurves(x: Curve, y: Curve, r: number): CornerResult | null {
  const corner = cornerPoint(x, y);
  if (!corner) return null;
  const a = legOf(x, corner);
  const b = legOf(y, corner);
  if (!a || !b || r <= 0) return null;

  // 角から外へ向かう 2 方向。なす角が 0 か π なら丸めようがない
  const u = mul(a.dir, -1);
  const v = mul(b.dir, -1);
  const cos = Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y));
  const theta = Math.acos(cos);
  if (theta < 1e-6 || Math.PI - theta < 1e-6) return null;

  const back = r / Math.tan(theta / 2);
  if (back >= dist(a.far, corner) || back >= dist(b.far, corner)) return null;

  const p1 = add(corner, mul(u, back));
  const p2 = add(corner, mul(v, back));
  const bisector = norm(add(u, v));
  const center = add(corner, mul(bisector, r / Math.sin(theta / 2)));

  // 中心から接点への角。start → end は常に反時計回りという約束に合わせる
  const s1 = angleOf(sub(p1, center));
  const s2 = angleOf(sub(p2, center));
  const ccw = normalizedSweep(s1, s2) <= Math.PI;
  return {
    trimmed: [
      { kind: 'segment', a: a.far, b: p1 },
      { kind: 'segment', a: b.far, b: p2 },
    ],
    bridge: {
      kind: 'arc',
      arc: { center, radius: r, start: ccw ? s1 : s2, end: ccw ? s2 : s1 },
    },
  };
}

/** start から end へ反時計回りに測った角。0..2π */
function normalizedSweep(start: number, end: number): number {
  let sweep = end - start;
  while (sweep < 0) sweep += Math.PI * 2;
  while (sweep >= Math.PI * 2) sweep -= Math.PI * 2;
  return sweep;
}

/**
 * 2 つの実体の角を処理して、シーンに書き戻す。
 *
 * **壁は面取りだけ。角の丸めはできない。** `Wall` は 2 つのノードを結ぶ直線で、
 * 円弧壁がまだ無いので、丸めた円弧を置く先が無い。断るほうが、黙って
 * 「丸めたつもりの折れ線」を作るより良い。
 */
export type CornerKind = 'chamfer' | 'fillet';

export interface CornerRequest {
  kind: CornerKind;
  /** 面取りの戻り（mm）。両辺とも同じ値を使う */
  distance: number;
  /** 角の丸めの半径 (mm) */
  radius: number;
}

export function cornerResult(x: Curve, y: Curve, req: CornerRequest): CornerResult | null {
  return req.kind === 'chamfer'
    ? chamferCurves(x, y, req.distance, req.distance)
    : filletCurves(x, y, req.radius);
}

/**
 * 2 つの実体の角を処理する。**図形と壁の組み合わせを問わない。**
 *
 * 図形は曲線を書き戻し、壁は**両端のノードを動かして**短くする
 * （壁は厚みを持つので、線に差し替えると壁でなくなる）。
 * あいだを埋めるものは、面取りなら新しい壁 1 本、角の丸めなら円弧の図形。
 *
 * **壁の角の丸めは断る。** `Wall` が直線なので、丸めた円弧を壁として
 * 置く先が無い（円弧壁はまだ無い）。
 */
export function cornerEntities(
  scene: Scene,
  x: EntityRef,
  y: EntityRef,
  req: CornerRequest,
): boolean {
  if (req.kind === 'fillet' && (x.type === 'wall' || y.type === 'wall')) return false;

  const cx = curveOfRef(scene, x);
  const cy = curveOfRef(scene, y);
  if (!cx || !cy) return false;

  const got = cornerResult(cx, cy, req);
  if (!got) return false;

  const template = x.type === 'shape' ? scene.shapes[x.id] : undefined;
  applyCorner(scene, x, got.trimmed[0]);
  applyCorner(scene, y, got.trimmed[1]);

  // あいだを埋めるもの。図形が 1 つも関わっていなければ壁として置く
  if (x.type === 'wall' && y.type === 'wall' && got.bridge.kind === 'segment') {
    const a = findOrCreateNode(scene, got.bridge.a, scene.walls[x.id]?.levelId);
    const b = findOrCreateNode(scene, got.bridge.b, scene.walls[x.id]?.levelId);
    addWall(scene, a, b, scene.walls[x.id]?.thickness ?? 100, scene.walls[x.id]?.layerId);
    return true;
  }
  const base = template ?? (y.type === 'shape' ? scene.shapes[y.id] : undefined);
  if (!base) return true;
  const bridge = curveToShape(got.bridge, base);
  if (bridge) scene.shapes[bridge.id] = bridge;
  return true;
}

/** 実体を 1 本の曲線として見る。折れ線や複数本になるものは対象外 */
function curveOfRef(scene: Scene, ref: EntityRef): Curve | null {
  if (ref.type === 'wall') {
    const wall = scene.walls[ref.id];
    return wall ? wallCurve(scene, wall) : null;
  }
  if (ref.type !== 'shape') return null;
  const shape = scene.shapes[ref.id];
  if (!shape) return null;
  const curves = shapeCurves(shape);
  return curves.length === 1 ? curves[0] : null;
}

/** 短くした曲線を実体に書き戻す */
function applyCorner(scene: Scene, ref: EntityRef, curve: Curve): void {
  if (ref.type === 'shape') {
    const shape = scene.shapes[ref.id];
    if (!shape) return;
    const next = curveToShape(curve, shape);
    if (next) scene.shapes[ref.id] = { ...next, id: ref.id };
    return;
  }
  const wall = scene.walls[ref.id];
  if (!wall || curve.kind !== 'segment') return;
  // **壁は線に差し替えない。** 動かすのは端のノードだけ。
  // 短くした曲線の 2 端のうち、始点ノードから遠いほうが「動いた側」
  const [a] = wallEnds(scene, wall);
  const movingA = dist(a, curve.a) > dist(a, curve.b);
  const move = movingA ? curve.a : curve.b;
  const nodeId = movingA ? wall.a : wall.b;
  const node = scene.nodes[nodeId];
  if (node) {
    node.x = move.x;
    node.y = move.y;
  }
}

import {
  EPS,
  add,
  angleOf,
  arcContainsAngle,
  arcSweepAngle,
  circleCircleIntersection,
  closestOnSegment,
  dist,
  lineCircleIntersection,
  lineLineIntersection,
  mul,
  norm,
  normalizeAngle,
  offsetPolyline,
  offsetSegment,
  projectParam,
  sideOfLine,
  sub,
  vec,
  type Arc,
  type Vec,
} from './geometry.ts';
import { newId } from './id.ts';
import { addWall, mergeNodesAt, splitWall, wallEnds } from './ops.ts';
import type { Shape } from './shapes.ts';
import type { Id, Scene, Wall } from './types.ts';

/**
 * トリム・延長・オフセットが扱う曲線。
 * 汎用図形も壁もここへ落としてから幾何に渡すので、同じコードで両方を扱える。
 */
export type Curve =
  | { kind: 'segment'; a: Vec; b: Vec }
  | { kind: 'arc'; arc: Arc }
  | { kind: 'circle'; center: Vec; radius: number };

export function shapeCurves(shape: Shape): Curve[] {
  switch (shape.shape) {
    case 'line':
      return [{ kind: 'segment', a: shape.a, b: shape.b }];
    case 'polyline': {
      const out: Curve[] = [];
      for (let i = 0; i + 1 < shape.points.length; i++) {
        out.push({ kind: 'segment', a: shape.points[i], b: shape.points[i + 1] });
      }
      if (shape.closed && shape.points.length > 2) {
        out.push({ kind: 'segment', a: shape.points[shape.points.length - 1], b: shape.points[0] });
      }
      return out;
    }
    case 'arc':
      return [
        { kind: 'arc', arc: { center: shape.center, radius: shape.radius, start: shape.startAngle, end: shape.endAngle } },
      ];
    case 'circle':
      return [{ kind: 'circle', center: shape.center, radius: shape.radius }];
    default:
      return [];
  }
}

export function wallCurve(scene: Scene, wall: Wall): Curve {
  const [a, b] = wallEnds(scene, wall);
  return { kind: 'segment', a, b };
}

/** 曲線どうしの交点。infinite なら線分を無限直線として扱う（延長の判定に使う） */
export function curveIntersections(x: Curve, y: Curve, infinite = false): Vec[] {
  const within = (c: Curve, p: Vec): boolean => {
    if (infinite) return true;
    switch (c.kind) {
      case 'segment': {
        const t = projectParam(c.a, c.b, p);
        return t >= -EPS && t <= 1 + EPS;
      }
      case 'arc':
        return arcContainsAngle(c.arc, angleOf(sub(p, c.arc.center)));
      case 'circle':
        return true;
    }
  };

  const raw = rawIntersections(x, y);
  return raw.filter((p) => within(x, p) && within(y, p));
}

/** 曲線を「円（中心と半径）」として見る。線分なら null */
function circleOf(c: Curve): { center: Vec; radius: number } | null {
  if (c.kind === 'circle') return { center: c.center, radius: c.radius };
  if (c.kind === 'arc') return { center: c.arc.center, radius: c.arc.radius };
  return null;
}

function rawIntersections(x: Curve, y: Curve): Vec[] {
  if (x.kind === 'segment' && y.kind === 'segment') {
    const hit = lineLineIntersection(x.a, x.b, y.a, y.b);
    return hit ? [hit.point] : [];
  }
  if (x.kind === 'segment') {
    const c = circleOf(y);
    return c ? lineCircleIntersection(x.a, x.b, c.center, c.radius).map((h) => h.point) : [];
  }
  if (y.kind === 'segment') {
    const c = circleOf(x);
    return c ? lineCircleIntersection(y.a, y.b, c.center, c.radius).map((h) => h.point) : [];
  }
  const c1 = circleOf(x);
  const c2 = circleOf(y);
  return c1 && c2 ? circleCircleIntersection(c1.center, c1.radius, c2.center, c2.radius) : [];
}

/** 対象上での位置をパラメータ化する。線分は 0..1、円弧・円は始点からの角度 */
function paramOf(curve: Curve, p: Vec): number {
  switch (curve.kind) {
    case 'segment':
      return projectParam(curve.a, curve.b, p);
    case 'arc':
      return normalizeAngle(angleOf(sub(p, curve.arc.center)) - curve.arc.start);
    case 'circle':
      return normalizeAngle(angleOf(sub(p, curve.center)));
  }
}

/**
 * pickPoint を含む区間を落とした残りを返す。
 * 交点が無ければ null（＝何もしない）。
 */
export function trimCurve(target: Curve, cutters: Curve[], pickPoint: Vec): Curve[] | null {
  const hits = cutters.flatMap((c) => curveIntersections(target, c));
  if (hits.length === 0) return null;

  const pick = paramOf(target, pickPoint);

  if (target.kind === 'segment') {
    // 端点ぴったりの交点は「切れていない」ので数えない。
    // これを入れないと、端で接しているだけの相手で図形まるごとが消える
    const cuts = hits.map((p) => paramOf(target, p)).filter((t) => t > EPS && t < 1 - EPS);
    if (cuts.length === 0) return null;
    const bounds = dedupeNumbers([0, 1, ...cuts].sort((a, b) => a - b));
    const i = bounds.findIndex((t, idx) => idx + 1 < bounds.length && pick >= t - EPS && pick <= bounds[idx + 1] + EPS);
    if (i < 0) return null;

    const out: Curve[] = [];
    const at = (t: number) => add(target.a, mul(sub(target.b, target.a), t));
    if (bounds[i] > EPS) out.push({ kind: 'segment', a: target.a, b: at(bounds[i]) });
    if (bounds[i + 1] < 1 - EPS) out.push({ kind: 'segment', a: at(bounds[i + 1]), b: target.b });
    return out;
  }

  if (target.kind === 'arc') {
    const sweep = arcSweepAngle(target.arc);
    const cuts = hits.map((p) => paramOf(target, p)).filter((t) => t > EPS && t < sweep - EPS);
    if (cuts.length === 0) return null;
    const bounds = dedupeNumbers([0, sweep, ...cuts].sort((a, b) => a - b));
    const i = bounds.findIndex((t, idx) => idx + 1 < bounds.length && pick >= t - EPS && pick <= bounds[idx + 1] + EPS);
    if (i < 0) return null;

    const out: Curve[] = [];
    const { center, radius, start } = target.arc;
    if (bounds[i] > EPS) out.push({ kind: 'arc', arc: { center, radius, start, end: start + bounds[i] } });
    if (bounds[i + 1] < sweep - EPS) {
      out.push({ kind: 'arc', arc: { center, radius, start: start + bounds[i + 1], end: start + sweep } });
    }
    return out;
  }

  // 円は2点以上で切れたときだけ、残りを1本の円弧にする
  const angles = dedupeNumbers(hits.map((p) => paramOf(target, p)).sort((a, b) => a - b));
  if (angles.length < 2) return null;
  const i = angles.findIndex((t, idx) => pick >= t - EPS && pick <= (angles[idx + 1] ?? t + Math.PI * 2) + EPS);
  const from = angles[i < 0 ? angles.length - 1 : i];
  const to = angles[(i < 0 ? 0 : i + 1) % angles.length];
  return [{ kind: 'arc', arc: { center: target.center, radius: target.radius, start: to, end: from } }];
}

/** pickPoint に近い側の端を、最も近い境界との交点まで伸ばす */
export function extendCurve(target: Curve, boundaries: Curve[], pickPoint: Vec): Curve | null {
  if (target.kind === 'circle') return null;

  const hits = boundaries.flatMap((c) => curveIntersections(target, c, true)).filter((p) => {
    // 境界側には実際に乗っている点だけを使う
    return boundaries.some((c) => onCurve(c, p));
  });
  if (hits.length === 0) return null;

  if (target.kind === 'segment') {
    const pick = projectParam(target.a, target.b, pickPoint);
    const toStart = pick < 0.5;
    const candidates = hits
      .map((p) => ({ p, t: projectParam(target.a, target.b, p) }))
      .filter((h) => (toStart ? h.t < -EPS : h.t > 1 + EPS));
    if (candidates.length === 0) return null;
    // 一番近い境界まで伸ばす
    const best = candidates.reduce((acc, h) => (Math.abs(h.t - (toStart ? 0 : 1)) < Math.abs(acc.t - (toStart ? 0 : 1)) ? h : acc));
    return toStart ? { kind: 'segment', a: best.p, b: target.b } : { kind: 'segment', a: target.a, b: best.p };
  }

  const { center, radius, start } = target.arc;
  const sweep = arcSweepAngle(target.arc);
  const pick = paramOf(target, pickPoint);
  const toStart = pick < sweep / 2;
  const candidates = hits
    .filter((p) => Math.abs(dist(p, center) - radius) < 1)
    .map((p) => normalizeAngle(angleOf(sub(p, center)) - start))
    .filter((t) => (toStart ? t > sweep + EPS : t > sweep + EPS));
  if (candidates.length === 0) return null;

  if (toStart) {
    // 始点側へ伸ばす＝始点を手前に戻す
    const best = Math.max(...candidates);
    return { kind: 'arc', arc: { center, radius, start: start + best, end: start + sweep } };
  }
  const best = Math.min(...candidates);
  return { kind: 'arc', arc: { center, radius, start, end: start + best } };
}

function onCurve(c: Curve, p: Vec): boolean {
  switch (c.kind) {
    case 'segment':
      return closestOnSegment(p, c.a, c.b).dist < 1;
    case 'arc':
      return Math.abs(dist(p, c.arc.center) - c.arc.radius) < 1 && arcContainsAngle(c.arc, angleOf(sub(p, c.arc.center)));
    case 'circle':
      return Math.abs(dist(p, c.center) - c.radius) < 1;
  }
}

function dedupeNumbers(values: number[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (out.length === 0 || Math.abs(out[out.length - 1] - v) > 1e-6) out.push(v);
  }
  return out;
}

// --- シーンへの適用 ---

/** 表示されていてロックされていない、トリム・延長の相手になる曲線を集める */
export function cutterCurves(scene: Scene, exclude: { shapeId?: Id; wallId?: Id }): Curve[] {
  const out: Curve[] = [];
  for (const shape of Object.values(scene.shapes)) {
    if (shape.id === exclude.shapeId) continue;
    const layer = scene.layers[shape.layerId];
    if (layer && (!layer.visible || layer.locked)) continue;
    out.push(...shapeCurves(shape));
  }
  for (const wall of Object.values(scene.walls)) {
    if (wall.id === exclude.wallId) continue;
    const layer = scene.layers[wall.layerId];
    if (layer && (!layer.visible || layer.locked)) continue;
    out.push(wallCurve(scene, wall));
  }
  return out;
}

/** 曲線を図形に戻す。元の図形の画層を引き継ぐ */
function curveToShape(curve: Curve, template: Shape): Shape | null {
  const id = newId('s');
  switch (curve.kind) {
    case 'segment':
      return { id, shape: 'line', layerId: template.layerId, a: curve.a, b: curve.b };
    case 'arc':
      return {
        id,
        shape: 'arc',
        layerId: template.layerId,
        center: curve.arc.center,
        radius: curve.arc.radius,
        startAngle: curve.arc.start,
        endAngle: curve.arc.end,
      };
    case 'circle':
      return { id, shape: 'circle', layerId: template.layerId, center: curve.center, radius: curve.radius };
  }
}

export function trimShape(scene: Scene, id: Id, pickPoint: Vec): boolean {
  const shape = scene.shapes[id];
  if (!shape) return false;
  const curves = shapeCurves(shape);
  if (curves.length !== 1) return false; // ポリラインは対象外

  const pieces = trimCurve(curves[0], cutterCurves(scene, { shapeId: id }), pickPoint);
  if (!pieces) return false;

  delete scene.shapes[id];
  for (const piece of pieces) {
    const next = curveToShape(piece, shape);
    if (next) scene.shapes[next.id] = next;
  }
  return true;
}

export function extendShape(scene: Scene, id: Id, pickPoint: Vec): boolean {
  const shape = scene.shapes[id];
  if (!shape) return false;
  const curves = shapeCurves(shape);
  if (curves.length !== 1) return false;

  const extended = extendCurve(curves[0], cutterCurves(scene, { shapeId: id }), pickPoint);
  if (!extended) return false;

  const next = curveToShape(extended, shape);
  if (!next) return false;
  scene.shapes[id] = { ...next, id };
  return true;
}

/** 平行な図形を新しく作る。元は動かさない */
export function offsetShape(scene: Scene, id: Id, distance: number, through: Vec): Id | null {
  const shape = scene.shapes[id];
  if (!shape || distance <= 0) return null;
  const newShapeId = newId('s');

  switch (shape.shape) {
    case 'line': {
      const side = sideOfLine(shape.a, shape.b, through);
      const [a, b] = offsetSegment(shape.a, shape.b, side * distance);
      scene.shapes[newShapeId] = { ...shape, id: newShapeId, a, b };
      return newShapeId;
    }
    case 'polyline': {
      // 最初の辺から見てどちら側かで符号を決める
      const side = sideOfLine(shape.points[0], shape.points[1], through);
      const points = offsetPolyline(shape.points, side * distance, shape.closed);
      if (!points) return null;
      scene.shapes[newShapeId] = { ...shape, id: newShapeId, points };
      return newShapeId;
    }
    case 'arc':
    case 'circle': {
      const outward = dist(through, shape.center) > shape.radius;
      const radius = shape.radius + (outward ? distance : -distance);
      if (radius <= 1) return null;
      scene.shapes[newShapeId] = { ...shape, id: newShapeId, radius };
      return newShapeId;
    }
    default:
      return null;
  }
}

// --- 壁（意味が曖昧でないものだけ） ---

/**
 * 壁の端点を、最も近い境界との交点まで伸ばす。
 * 角を閉じる操作そのもので、間取りでは一番使う。
 */
export function extendWall(scene: Scene, id: Id, pickPoint: Vec): boolean {
  const wall = scene.walls[id];
  if (!wall) return false;
  const [a, b] = wallEnds(scene, wall);
  const extended = extendCurve({ kind: 'segment', a, b }, cutterCurves(scene, { wallId: id }), pickPoint);
  if (!extended || extended.kind !== 'segment') return false;

  const toStart = dist(extended.a, a) > dist(extended.b, b);
  const nodeId = toStart ? wall.a : wall.b;
  const target = toStart ? extended.a : extended.b;
  const node = scene.nodes[nodeId];
  if (!node) return false;
  node.x = target.x;
  node.y = target.y;
  mergeNodesAt(scene, [nodeId]);
  return true;
}

/** 平行な壁を新しく作る。厚みと画層は引き継ぐ */
export function offsetWall(scene: Scene, id: Id, distance: number, through: Vec): Id | null {
  const wall = scene.walls[id];
  if (!wall || distance <= 0) return null;
  const [a, b] = wallEnds(scene, wall);
  const side = sideOfLine(a, b, through);
  const [na, nb] = offsetSegment(a, b, side * distance);

  const aId = newId('n');
  const bId = newId('n');
  scene.nodes[aId] = { id: aId, x: na.x, y: na.y };
  scene.nodes[bId] = { id: bId, x: nb.x, y: nb.y };
  return addWall(scene, aId, bId, wall.thickness, wall.layerId)?.id ?? null;
}

/**
 * 壁をトリムする。切った側を消す。
 * 切断線をまたぐ開口部は行き場がないので消える（`splitWall` の既存の規則と同じ）。
 */
export function trimWall(scene: Scene, id: Id, pickPoint: Vec): boolean {
  const wall = scene.walls[id];
  if (!wall) return false;
  const [a, b] = wallEnds(scene, wall);
  const hits = cutterCurves(scene, { wallId: id }).flatMap((c) =>
    curveIntersections({ kind: 'segment', a, b }, c),
  );
  if (hits.length === 0) return false;

  // クリックした側に一番近い交点で切る
  const pick = projectParam(a, b, pickPoint);
  const params = hits.map((p) => projectParam(a, b, p)).filter((t) => t > EPS && t < 1 - EPS);
  if (params.length === 0) return false;

  const cutAt = params.reduce((acc, t) => (Math.abs(t - pick) < Math.abs(acc - pick) ? t : acc));
  const splitPoint = add(a, mul(sub(b, a), cutAt));
  const midId = splitWall(scene, id, splitPoint, 1);
  if (!midId) return false;

  // 分割後、クリックした側の壁を消す
  const victim = Object.values(scene.walls).find((w) => {
    const [wa, wb] = wallEnds(scene, w);
    return closestOnSegment(pickPoint, wa, wb).dist < dist(a, b) && onSameLine(wa, wb, a, b) && containsParam(a, b, wa, wb, pick);
  });
  if (!victim) return false;
  for (const op of Object.values(scene.openings)) {
    if (op.wallId === victim.id) delete scene.openings[op.id];
  }
  delete scene.walls[victim.id];
  return true;
}

function onSameLine(wa: Vec, wb: Vec, a: Vec, b: Vec): boolean {
  const d = norm(sub(b, a));
  const n = vec(-d.y, d.x);
  const offA = Math.abs((wa.x - a.x) * n.x + (wa.y - a.y) * n.y);
  const offB = Math.abs((wb.x - a.x) * n.x + (wb.y - a.y) * n.y);
  return offA < 1 && offB < 1;
}

function containsParam(a: Vec, b: Vec, wa: Vec, wb: Vec, pick: number): boolean {
  const ta = projectParam(a, b, wa);
  const tb = projectParam(a, b, wb);
  return pick >= Math.min(ta, tb) - EPS && pick <= Math.max(ta, tb) + EPS;
}

import { dropConstraintsForWall } from './constraintOps.ts';
import {
  EPS,
  add,
  angleOf,
  arcContainsAngle,
  arcPointAt,
  arcSweepAngle,
  circleCircleIntersection,
  closestOnSegment,
  dist,
  ellipsePoints,
  lineCircleIntersection,
  lineLineIntersection,
  mul,
  norm,
  normalizeAngle,
  offsetPolyline,
  offsetSegment,
  projectParam,
  regularPolygonPoints,
  sideOfLine,
  sub,
  vec,
  type Arc,
  type Vec,
} from './geometry.ts';
import { newId } from './id.ts';
import { addWall, mergeNodesAt, splitWall, wallArc, wallEnds } from './ops.ts';
import { roundRectParts, type Shape } from './shapes.ts';
import type { Id, Scene, Wall } from './types.ts';

/**
 * トリム・延長・オフセットが扱う曲線。
 * 汎用図形も壁もここへ落としてから幾何に渡すので、同じコードで両方を扱える。
 */
export type Curve =
  | { kind: 'segment'; a: Vec; b: Vec }
  | { kind: 'arc'; arc: Arc }
  | { kind: 'circle'; center: Vec; radius: number };

/** 閉じた点の環を、辺ごとの線分にする */
function ringCurves(points: Vec[]): Curve[] {
  const out: Curve[] = [];
  for (let i = 0; i < points.length; i++) {
    out.push({ kind: 'segment', a: points[i], b: points[(i + 1) % points.length] });
  }
  return out;
}

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
    // 正多角形は辺そのものが線分
    case 'regularPolygon':
      return ringCurves(regularPolygonPoints(shape.center, shape.radius, shape.sides, shape.angle));
    // **角丸は折らない。** 直線 4 本と円弧 4 つをそのまま曲線にする
    case 'roundRect': {
      const { sides, corners } = roundRectParts(shape);
      return [
        ...sides.map((seg) => ({ kind: 'segment' as const, a: seg.a, b: seg.b })),
        ...corners.map((c) => ({
          kind: 'arc' as const,
          arc: { center: c.center, radius: c.radius, start: c.startAngle, end: c.endAngle },
        })),
      ];
    }
    // 楕円は曲線として表せないので折れ線になる。トリムの刃としては十分
    case 'ellipse':
      return ringCurves(ellipsePoints(shape.center, shape.major, shape.ratio, shape.angle));
    default:
      return [];
  }
}

/**
 * 壁を曲線として取り出す。**円弧壁は円弧として返す。**
 *
 * トリムの刃や角の丸めが弦を相手にすると、交点が壁から外れたところに出る。
 */
export function wallCurve(scene: Scene, wall: Wall): Curve {
  const [a, b] = wallEnds(scene, wall);
  const arc = wallArc(scene, wall);
  if (!arc) return { kind: 'segment', a, b };
  return {
    kind: 'arc',
    arc: {
      center: arc.center,
      radius: arc.radius,
      // `Arc` は start→end を反時計回りに読む。時計回りの弧は端を入れ替える
      start: arc.sweep >= 0 ? arc.from : arc.from + arc.sweep,
      end: arc.sweep >= 0 ? arc.from + arc.sweep : arc.from,
    },
  };
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

/**
 * 対象上での位置をパラメータ化する。線分は 0..1、円弧・円は始点からの角度。
 *
 * **`pointAtParam` と対になる。** 片方だけ直すと、切った位置と戻した点が
 * 食い違う。消しゴム・分割もこの 2 つを通る。
 */
export function paramOf(curve: Curve, p: Vec): number {
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
 * パラメータから点に戻す。`paramOf` の逆。
 *
 * 以前はこの変換が `trimCurve` の中に 3 回展開されていて、
 * 消しゴムと分割を足すと 5 回になるところだった。
 */
export function pointAtParam(curve: Curve, t: number): Vec {
  switch (curve.kind) {
    case 'segment':
      return add(curve.a, mul(sub(curve.b, curve.a), t));
    case 'arc':
      return arcPointAt(curve.arc.center, curve.arc.radius, curve.arc.start + t);
    case 'circle':
      return arcPointAt(curve.center, curve.radius, t);
  }
}

/**
 * 対象を、交点で区切った区間の境界に分ける。
 *
 * **トリム・分割・消しゴムはここから分かれる。** トリムは pick の入る区間を
 * 捨て、分割は全部残し、消しゴムは指した範囲だけを捨てる。
 * 戻り値は昇順で、両端（線分なら 0 と 1、円弧なら 0 と掃き角）を含む。
 * 切れていなければ null。
 */
export function curveBounds(target: Curve, cutters: Curve[]): number[] | null {
  const hits = cutters.flatMap((c) => curveIntersections(target, c));
  if (hits.length === 0) return null;

  if (target.kind === 'circle') {
    // 円は閉じているので端が無い。2 点以上で切れたときだけ意味を持つ
    const angles = dedupeNumbers(hits.map((p) => paramOf(target, p)).sort((a, b) => a - b));
    return angles.length < 2 ? null : angles;
  }

  const span = target.kind === 'segment' ? 1 : arcSweepAngle(target.arc);
  // 端点ぴったりの交点は「切れていない」ので数えない。
  // これを入れないと、端で接しているだけの相手で図形まるごとが消える
  const cuts = hits.map((p) => paramOf(target, p)).filter((t) => t > EPS && t < span - EPS);
  if (cuts.length === 0) return null;
  return dedupeNumbers([0, span, ...cuts].sort((a, b) => a - b));
}

/**
 * pickPoint を含む区間を落とした残りを返す。
 * 交点が無ければ null（＝何もしない）。
 */
export function trimCurve(target: Curve, cutters: Curve[], pickPoint: Vec): Curve[] | null {
  const bounds = curveBounds(target, cutters);
  if (!bounds) return null;
  const pick = paramOf(target, pickPoint);

  if (target.kind === 'circle') {
    // 円は2点以上で切れたときだけ、残りを1本の円弧にする
    const i = bounds.findIndex((t, idx) => pick >= t - EPS && pick <= (bounds[idx + 1] ?? t + Math.PI * 2) + EPS);
    const from = bounds[i < 0 ? bounds.length - 1 : i];
    const to = bounds[(i < 0 ? 0 : i + 1) % bounds.length];
    return [{ kind: 'arc', arc: { center: target.center, radius: target.radius, start: to, end: from } }];
  }

  const i = bounds.findIndex((t, idx) => idx + 1 < bounds.length && pick >= t - EPS && pick <= bounds[idx + 1] + EPS);
  if (i < 0) return null;
  // **pick の入る区間だけを落とす。** 分割はここで全部残す
  return spanCurves(target, bounds).filter((_, idx) => idx !== i);
}

/**
 * 交点のところで全部に分ける。**トリムとは出口だけが違う。**
 *
 * トリムが「pick の入る 1 区間を落とす」のに対し、分割は**全部残す**。
 * 切れていなければ null（＝何もしない）。1 本のままなら分けた意味が無いので、
 * 2 本以上になったときだけ返す。
 */
export function splitCurve(target: Curve, cutters: Curve[]): Curve[] | null {
  const bounds = curveBounds(target, cutters);
  if (!bounds) return null;

  if (target.kind === 'circle') {
    // 円は閉じているので、境界どうしを順に結んで円弧の列にする
    const out: Curve[] = [];
    for (let i = 0; i < bounds.length; i++) {
      const from = bounds[i];
      const to = bounds[(i + 1) % bounds.length];
      out.push({ kind: 'arc', arc: { center: target.center, radius: target.radius, start: from, end: to } });
    }
    return out.length >= 2 ? out : null;
  }

  const pieces = spanCurves(target, bounds);
  return pieces.length >= 2 ? pieces : null;
}

/**
 * 指した 2 点のあいだだけを落とす。**交点がなくても動く。**
 *
 * トリムと分割は「ほかの図形と交わっているところ」で切るが、
 * 消しゴムは**指した範囲**で切る。壁に当たっていない線の途中を
 * 消したいときに要る。
 */
export function eraseCurveSpan(target: Curve, from: Vec, to: Vec): Curve[] | null {
  const span = target.kind === 'segment' ? 1 : target.kind === 'arc' ? arcSweepAngle(target.arc) : Math.PI * 2;
  const a = paramOf(target, from);
  const b = paramOf(target, to);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (hi - lo <= EPS) return null;

  if (target.kind === 'circle') {
    // 円から一部を抜くと、残りは 1 本の円弧
    return [{ kind: 'arc', arc: { center: target.center, radius: target.radius, start: hi, end: lo } }];
  }
  // 範囲が実体からはみ出していれば、重なっているところだけを落とす
  const cutFrom = Math.max(0, lo);
  const cutTo = Math.min(span, hi);
  if (cutTo - cutFrom <= EPS) return null;

  const bounds = dedupeNumbers([0, cutFrom, cutTo, span].sort((x, y) => x - y));
  const out: Curve[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    // 落とす範囲に収まっている区間だけを捨てる
    if (bounds[i] >= cutFrom - EPS && bounds[i + 1] <= cutTo + EPS) continue;
    out.push(...spanCurves(target, [bounds[i], bounds[i + 1]]));
  }
  return out;
}

/**
 * 区間の境界から、区間ごとの曲線を作る。**トリムと分割の共通部分。**
 * 長さが EPS に満たない区間は落とす（端で切れたときの屑）。
 */
function spanCurves(target: Curve, bounds: number[]): Curve[] {
  const out: Curve[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const from = bounds[i];
    const to = bounds[i + 1];
    if (to - from <= EPS) continue;
    if (target.kind === 'segment') {
      out.push({ kind: 'segment', a: pointAtParam(target, from), b: pointAtParam(target, to) });
    } else if (target.kind === 'arc') {
      const { center, radius, start } = target.arc;
      out.push({ kind: 'arc', arc: { center, radius, start: start + from, end: start + to } });
    }
  }
  return out;
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

/** 曲線を図形に戻す。元の図形の画層と階を引き継ぐ */
export function curveToShape(curve: Curve, template: Shape): Shape | null {
  const id = newId('s');
  const { layerId, levelId } = template;
  const attrs = { ...template.attrs };
  switch (curve.kind) {
    case 'segment':
      return { id, shape: 'line', layerId, levelId, attrs, a: curve.a, b: curve.b };
    case 'arc':
      return {
        id,
        shape: 'arc',
        layerId,
        levelId,
        attrs,
        center: curve.arc.center,
        radius: curve.arc.radius,
        startAngle: curve.arc.start,
        endAngle: curve.arc.end,
      };
    case 'circle':
      return { id, shape: 'circle', layerId, levelId, attrs, center: curve.center, radius: curve.radius };
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

/**
 * 交点のところで図形を分ける。**トリムと同じ道を通り、出口だけが違う。**
 *
 * `trimShape` と同じく元を消して破片を入れ直すので、**id は変わる**
 * （延長が id を保つのと対照的。延長は 1 本のままだから）。
 */
export function splitShape(scene: Scene, id: Id, _pickPoint: Vec): boolean {
  const shape = scene.shapes[id];
  if (!shape) return false;
  const curves = shapeCurves(shape);
  if (curves.length !== 1) return false; // ポリラインは対象外

  const pieces = splitCurve(curves[0], cutterCurves(scene, { shapeId: id }));
  if (!pieces) return false;

  delete scene.shapes[id];
  for (const piece of pieces) {
    const next = curveToShape(piece, shape);
    if (next) scene.shapes[next.id] = next;
  }
  return true;
}

/** 指した 2 点のあいだを図形から抜く。交点がなくても動く */
export function eraseShapeSpan(scene: Scene, id: Id, from: Vec, to: Vec): boolean {
  const shape = scene.shapes[id];
  if (!shape) return false;
  const curves = shapeCurves(shape);
  if (curves.length !== 1) return false;

  const pieces = eraseCurveSpan(curves[0], from, to);
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
    // 外接円・長半径を伸び縮みさせる。**形はそのまま一回り大きく（小さく）なる**
    case 'regularPolygon': {
      const outward = dist(through, shape.center) > shape.radius;
      const radius = shape.radius + (outward ? distance : -distance);
      if (radius <= 1) return null;
      scene.shapes[newShapeId] = { ...shape, id: newShapeId, radius };
      return newShapeId;
    }
    case 'ellipse': {
      const outward = dist(through, shape.center) > shape.major * shape.ratio;
      const major = shape.major + (outward ? distance : -distance);
      if (major <= 1) return null;
      scene.shapes[newShapeId] = { ...shape, id: newShapeId, major };
      return newShapeId;
    }
    case 'roundRect': {
      // 角丸は縦横に同じだけ太らせる。角の R も一緒に動かさないと
      // 「外側に等距離」にならない
      const inside = Math.abs(through.x - shape.center.x) < Math.abs(shape.w) / 2
        && Math.abs(through.y - shape.center.y) < Math.abs(shape.h) / 2;
      const d = inside ? -distance : distance;
      const w = shape.w + d * 2;
      const h = shape.h + d * 2;
      if (w <= 1 || h <= 1) return null;
      scene.shapes[newShapeId] = {
        ...shape, id: newShapeId, w, h, radius: Math.max(0, shape.radius + d),
      };
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
  // **円弧壁は伸ばさない。** 端点だけを交点まで動かすと、弦が変わって
  // 半径が勝手に変わる（膨らみは掃過角で、半径は弦から導かれるため）。
  // 曲率を保ったまま伸ばすには、円の上を回す別の操作が要る
  if (wall.bulge !== 0) return false;
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
  const arc = wallArc(scene, wall);
  let na: Vec;
  let nb: Vec;
  if (arc) {
    // **同心円弧になる。** 掃過角は変わらないので膨らみはそのまま使える。
    // 中心から見てどちら側かで、半径を伸ばすか縮めるかが決まる
    const out = dist(through, arc.center) > arc.radius ? 1 : -1;
    const radius = arc.radius + out * distance;
    if (radius <= 1e-6) return null;
    const grow = (p: Vec): Vec =>
      add(arc.center, mul(norm(sub(p, arc.center)), radius));
    na = grow(a);
    nb = grow(b);
  } else {
    const side = sideOfLine(a, b, through);
    [na, nb] = offsetSegment(a, b, side * distance);
  }

  const aId = newId('n');
  const bId = newId('n');
  scene.nodes[aId] = { id: aId, x: na.x, y: na.y, levelId: wall.levelId };
  scene.nodes[bId] = { id: bId, x: nb.x, y: nb.y, levelId: wall.levelId };
  return addWall(scene, aId, bId, wall.thickness, wall.layerId, wall.bulge)?.id ?? null;
}

/**
 * 壁をトリムする。切った側を消す。
 * 切断線をまたぐ開口部は行き場がないので消える（`splitWall` の既存の規則と同じ）。
 */
export function trimWall(scene: Scene, id: Id, pickPoint: Vec): boolean {
  const wall = scene.walls[id];
  if (!wall) return false;
  // **円弧壁は切らない。** 切る位置も「どちら側を落とすか」も弦の上の
  // 比で決めているので、曲がった壁では見当違いのところで切れる。
  // 分割（`splitWall`）は弧の上で割るので、そちらは使える
  if (wall.bulge !== 0) return false;
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
  dropConstraintsForWall(scene, victim.id);
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

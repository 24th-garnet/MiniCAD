import { closestOnSegment, dist, pointInPolygon, vec, type Vec } from './geometry.ts';
import { isSelectable } from './entity.ts';
import { wallEnds } from './ops.ts';
import { instanceOutline, instanceVertices } from './block.ts';
import { openingFrame } from './shape.ts';
import { outline, outlineSegments, specOf } from './fixture.ts';
import { shapeHitTest, shapePickPriority, shapeVertices } from './shapes.ts';
import type { EntityRef, Scene } from './types.ts';

/** これ未満の優先度は「小物」。壁や家具より先に拾う */
const SMALL_SHAPE_PRIORITY = 3;

export interface PickOptions {
  /** 非表示・ロックされた画層のものを除外する。既定は true */
  respectLayers?: boolean;
}

/**
 * 画面上のクリック位置に対応するエンティティを1つ返す。
 * 小さく掴みにくいものほど先に判定する: 端点 > 開口 > 家具 > 壁 > 部屋名。
 */
export function pickAt(scene: Scene, p: Vec, tolerance: number, opts: PickOptions = {}): EntityRef | null {
  const ok = pickFilter(scene, opts);

  let bestNode: { ref: EntityRef; d: number } | null = null;
  for (const n of Object.values(scene.nodes)) {
    const d = dist(p, vec(n.x, n.y));
    if (d > tolerance) continue;
    const ref: EntityRef = { type: 'node', id: n.id };
    if (!ok(ref)) continue;
    if (!bestNode || d < bestNode.d) bestNode = { ref, d };
  }
  if (bestNode) return bestNode.ref;

  // 点や文字は小さく掴みにくいので、壁や家具より先に拾う
  const small = pickShape(scene, p, tolerance, ok, (s) => shapePickPriority(s) < SMALL_SHAPE_PRIORITY);
  if (small) return small;

  for (const op of Object.values(scene.openings)) {
    const ref: EntityRef = { type: 'opening', id: op.id };
    if (!ok(ref)) continue;
    const frame = openingFrame(scene, op);
    if (!frame) continue;
    const c = closestOnSegment(p, frame.start, frame.end);
    if (c.dist <= Math.max(tolerance, frame.thickness / 2)) return ref;
  }

  // 後から置いたものが上に来るので逆順に判定する
  for (const inst of Object.values(scene.instances).reverse()) {
    const ref: EntityRef = { type: 'blockInstance', id: inst.id };
    if (!ok(ref)) continue;
    if (pointInPolygon(p, instanceVertices(scene, inst))) return ref;
    // 輪郭のすぐ近くでも掴めるようにする（中が空いている記号もあるため）
    if (instanceOutline(scene, inst).some((s) => closestOnSegment(p, s.a, s.b).dist <= tolerance)) return ref;
  }

  const curve = pickShape(scene, p, tolerance, ok, (s) => shapePickPriority(s) >= SMALL_SHAPE_PRIORITY);
  if (curve) return curve;

  // 構造は壁より先に拾う。柱は壁の中に立つことが多く、後に回すと掴めない。
  // 種別の間の順は表の `pickPriority`（柱 → 梁 → 階段 → 吹抜）
  const fixtures = Object.values(scene.fixtures)
    .slice()
    .sort((a, b) => specOf(a).pickPriority - specOf(b).pickPriority);
  for (const f of fixtures) {
    const ref: EntityRef = { type: 'fixture', id: f.id };
    if (!ok(ref)) continue;
    if (pointInPolygon(p, outline(f))) return ref;
    if (outlineSegments(f).some((sg) => closestOnSegment(p, sg.a, sg.b).dist <= tolerance)) return ref;
  }

  let bestWall: { ref: EntityRef; d: number } | null = null;
  for (const w of Object.values(scene.walls)) {
    const ref: EntityRef = { type: 'wall', id: w.id };
    if (!ok(ref)) continue;
    const [a, b] = wallEnds(scene, w);
    const c = closestOnSegment(p, a, b);
    if (c.dist > Math.max(tolerance, w.thickness / 2)) continue;
    if (!bestWall || c.dist < bestWall.d) bestWall = { ref, d: c.dist };
  }
  if (bestWall) return bestWall.ref;

  for (const label of Object.values(scene.roomLabels)) {
    const ref: EntityRef = { type: 'roomLabel', id: label.id };
    if (!ok(ref)) continue;
    if (dist(p, vec(label.x, label.y)) <= tolerance * 3) return ref;
  }

  // 計測はいちばん最後。図面の上に重ねた道具なので、図面の邪魔をしない
  for (const m of Object.values(scene.measurements)) {
    const ref: EntityRef = { type: 'measurement', id: m.id };
    if (!ok(ref)) continue;
    if (closestOnSegment(p, vec(m.a.x, m.a.y), vec(m.b.x, m.b.y)).dist <= tolerance) return ref;
  }

  return null;
}

/** 矩形選択。min/max はワールド座標 */
export function pickInRect(
  scene: Scene,
  min: Vec,
  max: Vec,
  crossing: boolean,
  opts: PickOptions = {},
): EntityRef[] {
  const ok = pickFilter(scene, opts);
  const inside = (q: Vec): boolean => q.x >= min.x && q.x <= max.x && q.y >= min.y && q.y <= max.y;
  const refs: EntityRef[] = [];

  for (const w of Object.values(scene.walls)) {
    const ref: EntityRef = { type: 'wall', id: w.id };
    if (!ok(ref)) continue;
    const [a, b] = wallEnds(scene, w);
    const hit = crossing ? inside(a) || inside(b) || segmentCrossesRect(a, b, min, max) : inside(a) && inside(b);
    if (hit) refs.push(ref);
  }
  for (const inst of Object.values(scene.instances)) {
    const ref: EntityRef = { type: 'blockInstance', id: inst.id };
    if (!ok(ref)) continue;
    const corners = instanceVertices(scene, inst);
    if (crossing ? corners.some(inside) : corners.every(inside)) refs.push(ref);
  }
  for (const op of Object.values(scene.openings)) {
    const ref: EntityRef = { type: 'opening', id: op.id };
    if (!ok(ref)) continue;
    const frame = openingFrame(scene, op);
    if (!frame) continue;
    const hit = crossing ? inside(frame.start) || inside(frame.end) : inside(frame.start) && inside(frame.end);
    if (hit) refs.push(ref);
  }
  for (const label of Object.values(scene.roomLabels)) {
    const ref: EntityRef = { type: 'roomLabel', id: label.id };
    if (!ok(ref)) continue;
    if (inside(vec(label.x, label.y))) refs.push(ref);
  }
  for (const shape of Object.values(scene.shapes)) {
    const ref: EntityRef = { type: 'shape', id: shape.id };
    if (!ok(ref)) continue;
    const pts = shapeVertices(scene, shape);
    if (pts.length === 0) continue;
    if (crossing ? pts.some(inside) : pts.every(inside)) refs.push(ref);
  }
  for (const f of Object.values(scene.fixtures)) {
    const ref: EntityRef = { type: 'fixture', id: f.id };
    if (!ok(ref)) continue;
    const corners = outline(f);
    if (crossing ? corners.some(inside) : corners.every(inside)) refs.push(ref);
  }
  for (const m of Object.values(scene.measurements)) {
    const ref: EntityRef = { type: 'measurement', id: m.id };
    if (!ok(ref)) continue;
    const ends = [vec(m.a.x, m.a.y), vec(m.b.x, m.b.y)];
    if (crossing ? ends.some(inside) : ends.every(inside)) refs.push(ref);
  }
  return refs;
}

/** 条件に合う図形のうち、最も近いものを返す */
function pickShape(
  scene: Scene,
  p: Vec,
  tolerance: number,
  ok: (ref: EntityRef) => boolean,
  accept: (s: Parameters<typeof shapePickPriority>[0]) => boolean,
): EntityRef | null {
  let best: { ref: EntityRef; score: number } | null = null;
  for (const shape of Object.values(scene.shapes)) {
    if (!accept(shape)) continue;
    const ref: EntityRef = { type: 'shape', id: shape.id };
    if (!ok(ref)) continue;
    const d = shapeHitTest(scene, shape, p, tolerance, scene.standard);
    if (d === null) continue;
    // 優先度を距離より強く効かせる（snap.ts の consider と同じ考え方）
    const score = shapePickPriority(shape) * 1e6 + d;
    if (!best || score < best.score) best = { ref, score };
  }
  return best?.ref ?? null;
}

function pickFilter(scene: Scene, opts: PickOptions): (ref: EntityRef) => boolean {
  if (opts.respectLayers === false) return () => true;
  return (ref) => isSelectable(scene, ref);
}

function segmentCrossesRect(a: Vec, b: Vec, min: Vec, max: Vec): boolean {
  const corners = [vec(min.x, min.y), vec(max.x, min.y), vec(max.x, max.y), vec(min.x, max.y)];
  for (let i = 0; i < 4; i++) {
    if (segmentsIntersect(a, b, corners[i], corners[(i + 1) % 4])) return true;
  }
  return false;
}

function segmentsIntersect(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const o = (p: Vec, q: Vec, r: Vec): number => {
    const v = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return Math.abs(v) < 1e-9 ? 0 : Math.sign(v);
  };
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

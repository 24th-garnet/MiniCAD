import { closestOnSegment, dist, pointInPolygon, vec, type Vec } from './geometry.ts';
import { wallEnds } from './ops.ts';
import { furniturePolygon, openingFrame } from './shape.ts';
import type { EntityRef, Scene } from './types.ts';

/**
 * 画面上のクリック位置に対応するエンティティを1つ返す。
 * 小さく掴みにくいものほど先に判定する: 端点 > 開口 > 家具 > 壁 > 部屋名。
 */
export function pickAt(scene: Scene, p: Vec, tolerance: number): EntityRef | null {
  let bestNode: { ref: EntityRef; d: number } | null = null;
  for (const n of Object.values(scene.nodes)) {
    const d = dist(p, vec(n.x, n.y));
    if (d <= tolerance && (!bestNode || d < bestNode.d)) {
      bestNode = { ref: { type: 'node', id: n.id }, d };
    }
  }
  if (bestNode) return bestNode.ref;

  for (const op of Object.values(scene.openings)) {
    const frame = openingFrame(scene, op);
    if (!frame) continue;
    const c = closestOnSegment(p, frame.start, frame.end);
    if (c.dist <= Math.max(tolerance, frame.thickness / 2)) {
      return { type: 'opening', id: op.id };
    }
  }

  // 後から置いたものが上に来るので逆順に判定する
  const furniture = Object.values(scene.furniture).reverse();
  for (const f of furniture) {
    if (pointInPolygon(p, furniturePolygon(f))) return { type: 'furniture', id: f.id };
  }

  let bestWall: { ref: EntityRef; d: number } | null = null;
  for (const w of Object.values(scene.walls)) {
    const [a, b] = wallEnds(scene, w);
    const c = closestOnSegment(p, a, b);
    const limit = Math.max(tolerance, w.thickness / 2);
    if (c.dist <= limit && (!bestWall || c.dist < bestWall.d)) {
      bestWall = { ref: { type: 'wall', id: w.id }, d: c.dist };
    }
  }
  if (bestWall) return bestWall.ref;

  for (const label of Object.values(scene.roomLabels)) {
    if (dist(p, vec(label.x, label.y)) <= tolerance * 3) {
      return { type: 'roomLabel', id: label.id };
    }
  }

  return null;
}

/** 矩形選択。min/max はワールド座標 */
export function pickInRect(scene: Scene, min: Vec, max: Vec, crossing: boolean): EntityRef[] {
  const inside = (q: Vec): boolean => q.x >= min.x && q.x <= max.x && q.y >= min.y && q.y <= max.y;
  const refs: EntityRef[] = [];

  for (const w of Object.values(scene.walls)) {
    const [a, b] = wallEnds(scene, w);
    const hit = crossing ? inside(a) || inside(b) || segmentCrossesRect(a, b, min, max) : inside(a) && inside(b);
    if (hit) refs.push({ type: 'wall', id: w.id });
  }
  for (const f of Object.values(scene.furniture)) {
    const corners = furniturePolygon(f);
    const hit = crossing ? corners.some(inside) : corners.every(inside);
    if (hit) refs.push({ type: 'furniture', id: f.id });
  }
  for (const op of Object.values(scene.openings)) {
    const frame = openingFrame(scene, op);
    if (!frame) continue;
    const hit = crossing ? inside(frame.start) || inside(frame.end) : inside(frame.start) && inside(frame.end);
    if (hit) refs.push({ type: 'opening', id: op.id });
  }
  for (const label of Object.values(scene.roomLabels)) {
    if (inside(vec(label.x, label.y))) refs.push({ type: 'roomLabel', id: label.id });
  }
  return refs;
}

function segmentCrossesRect(a: Vec, b: Vec, min: Vec, max: Vec): boolean {
  const corners = [vec(min.x, min.y), vec(max.x, min.y), vec(max.x, max.y), vec(min.x, max.y)];
  for (let i = 0; i < 4; i++) {
    const c = corners[i];
    const d = corners[(i + 1) % 4];
    if (segmentsIntersect(a, b, c, d)) return true;
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

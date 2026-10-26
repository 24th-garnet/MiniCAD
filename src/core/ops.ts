import { defaultAttrs } from './attrs.ts';
import { dist, closestOnSegment, vec, type Vec } from './geometry.ts';
import { LAYER_IDS, type LayerId } from './layer.ts';
import { newId, type Id, type Opening, type Scene, type Wall } from './types.ts';
import { dropConstraintsForWall, splitConstraints } from './constraintOps.ts';

/** 同一ノードとみなす距離 (mm) */
export const NODE_MERGE_TOLERANCE = 1;

export function nodePos(scene: Scene, id: Id): Vec {
  const n = scene.nodes[id];
  return n ? vec(n.x, n.y) : vec(0, 0);
}

export function wallEnds(scene: Scene, wall: Wall): [Vec, Vec] {
  return [nodePos(scene, wall.a), nodePos(scene, wall.b)];
}

export function wallLength(scene: Scene, wall: Wall): number {
  const [a, b] = wallEnds(scene, wall);
  return dist(a, b);
}

/**
 * 指定座標にノードを作る。既存ノードが十分近ければそれを使い回す。
 *
 * **同じ階のノードだけを使い回す。** 階を見ないと、1 階と 2 階の同じ座標の角が
 * 1 つに溶けて、片方を動かすともう片方も動く。
 */
export function findOrCreateNode(
  scene: Scene,
  p: Vec,
  levelId: Id = scene.activeLevelId,
  tolerance = NODE_MERGE_TOLERANCE,
): Id {
  for (const n of Object.values(scene.nodes)) {
    if (n.levelId !== levelId) continue;
    if (dist(p, n) <= tolerance) return n.id;
  }
  const id = newId('n');
  scene.nodes[id] = { id, x: p.x, y: p.y, levelId };
  return id;
}

/** 壁は両端ノードの階に乗る。食い違っていれば作らない */
export function addWall(scene: Scene, a: Id, b: Id, thickness: number, layerId: LayerId = LAYER_IDS.wall): Wall | null {
  if (a === b) return null;
  const na = scene.nodes[a];
  const nb = scene.nodes[b];
  if (!na || !nb || na.levelId !== nb.levelId) return null;
  const existing = Object.values(scene.walls).find(
    (w) => (w.a === a && w.b === b) || (w.a === b && w.b === a),
  );
  if (existing) return existing;
  const id = newId('w');
  const wall: Wall = {
    id, a, b, thickness, height: null, layerId, levelId: na.levelId, attrs: defaultAttrs(),
  };
  scene.walls[id] = wall;
  return wall;
}

/**
 * 壁を指定点で分割して新しいノードを返す。
 * 端点に近すぎる場合は分割せずその端点を返す。開口部は分割後の正しい側へ引き継ぐ。
 */
export function splitWall(scene: Scene, wallId: Id, p: Vec, tolerance = 20): Id | null {
  const wall = scene.walls[wallId];
  if (!wall) return null;
  const [a, b] = wallEnds(scene, wall);
  const { t, point } = closestOnSegment(p, a, b);
  const total = dist(a, b);
  const atStart = t * total;
  if (atStart <= tolerance) return wall.a;
  if (total - atStart <= tolerance) return wall.b;

  const midId = newId('n');
  scene.nodes[midId] = { id: midId, x: point.x, y: point.y, levelId: wall.levelId };

  const originalB = wall.b;
  wall.b = midId;
  const second = addWall(scene, midId, originalB, wall.thickness, wall.layerId);
  // 角度系の拘束は後半にも効かせ、長さの拘束は意味が壊れるので捨てる
  if (second) splitConstraints(scene, wallId, second.id);

  for (const op of Object.values(scene.openings)) {
    if (op.wallId !== wallId) continue;
    if (op.offset + op.width / 2 <= atStart) continue;
    if (op.offset - op.width / 2 >= atStart && second) {
      op.wallId = second.id;
      op.offset -= atStart;
    } else {
      // 分割線を跨ぐ開口は行き場がないので削除する
      delete scene.openings[op.id];
    }
  }
  return midId;
}

/** どの壁からも参照されなくなったノードを掃除する */
export function pruneOrphanNodes(scene: Scene): void {
  const used = new Set<Id>();
  for (const w of Object.values(scene.walls)) {
    used.add(w.a);
    used.add(w.b);
  }
  for (const id of Object.keys(scene.nodes)) {
    if (!used.has(id)) delete scene.nodes[id];
  }
}

export function wallsAtNode(scene: Scene, nodeId: Id): Wall[] {
  return Object.values(scene.walls).filter((w) => w.a === nodeId || w.b === nodeId);
}

export function openingsOnWall(scene: Scene, wallId: Id): Opening[] {
  return Object.values(scene.openings)
    .filter((o) => o.wallId === wallId)
    .sort((x, y) => x.offset - y.offset);
}

/** 開口を壁内に収め、他の開口と重ならない位置へ丸める。置けないなら null */
export function clampOpening(scene: Scene, wallId: Id, offset: number, width: number, ignoreId?: Id): number | null {
  const wall = scene.walls[wallId];
  if (!wall) return null;
  const total = wallLength(scene, wall);
  const margin = 20;
  if (total < width + margin * 2) return null;
  let lo = width / 2 + margin;
  let hi = total - width / 2 - margin;
  for (const other of openingsOnWall(scene, wallId)) {
    if (other.id === ignoreId) continue;
    const oLo = other.offset - other.width / 2;
    const oHi = other.offset + other.width / 2;
    if (offset < other.offset) hi = Math.min(hi, oLo - width / 2);
    else lo = Math.max(lo, oHi + width / 2);
  }
  if (lo > hi) return null;
  return Math.max(lo, Math.min(hi, offset));
}


/** ノードをまとめて移動する（壁は端点を共有しているので自動的に追従する） */
export function moveNodes(scene: Scene, ids: Id[], delta: Vec): void {
  for (const id of ids) {
    const n = scene.nodes[id];
    if (!n) continue;
    n.x += delta.x;
    n.y += delta.y;
  }
}

/**
 * ドラッグ後に重なったノードを統合する。これがないと壁が繋がって見えても別々のままになる。
 *
 * **階をまたいでは統合しない。** `findOrCreateNode` と同じ理由。
 */
export function mergeNodesAt(scene: Scene, movedIds: Id[], tolerance = 30): boolean {
  let merged = false;
  for (const id of movedIds) {
    const node = scene.nodes[id];
    if (!node) continue;
    for (const other of Object.values(scene.nodes)) {
      if (other.id === id || movedIds.includes(other.id)) continue;
      if (other.levelId !== node.levelId) continue;
      if (dist(node, other) > tolerance) continue;
      for (const w of Object.values(scene.walls)) {
        if (w.a === id) w.a = other.id;
        if (w.b === id) w.b = other.id;
      }
      delete scene.nodes[id];
      merged = true;
      break;
    }
  }
  if (merged) {
    // 統合で潰れた壁（始点=終点）と重複した壁を落とす
    const seen = new Set<string>();
    for (const w of Object.values(scene.walls)) {
      const key = [w.a, w.b].sort().join('|');
      if (w.a === w.b || seen.has(key)) {
        dropConstraintsForWall(scene, w.id);
        delete scene.walls[w.id];
        for (const op of Object.values(scene.openings)) {
          if (op.wallId === w.id) delete scene.openings[op.id];
        }
        continue;
      }
      seen.add(key);
    }
    pruneOrphanNodes(scene);
  }
  return merged;
}

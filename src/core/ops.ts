import { defaultAttrs } from './attrs.ts';
import {
  add, arcFromBulge, bulgeArcLength, closestOnArc, closestOnSegment, dist, mul, norm,
  pointOnBulgeArc, sub, vec, type BulgeArc, type Vec,
} from './geometry.ts';
import { LAYER_IDS, type LayerId } from './layer.ts';
import { newId, type Id, type Opening, type Scene, type Wall } from './types.ts';
import { sameOpening, type OpeningIdentity } from './opening.ts';
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

/**
 * 壁の円弧。**直線なら null。** 中心は 2 端点と膨らみから毎回導く
 *
 * ここが円弧壁の唯一の出どころ。壁の形を知りたいところは全部これを通す。
 */
export function wallArc(scene: Scene, wall: Wall): BulgeArc | null {
  const [a, b] = wallEnds(scene, wall);
  return arcFromBulge(a, b, wall.bulge);
}

/**
 * 壁の長さ。**円弧壁では弧長**で、弦の長さではない。
 *
 * **ここを弦のままにすると開口が全部ずれる。** `clampOpening` も
 * `mergeOpeningSpan` も `wallSpans` も、開口の `offset` を
 * 「0 から `wallLength` までの 1 次元の座標」として扱っている。
 * その物差しが縮むと、置いた窓が黙って動く。
 */
export function wallLength(scene: Scene, wall: Wall): number {
  const arc = wallArc(scene, wall);
  if (arc) return bulgeArcLength(arc);
  const [a, b] = wallEnds(scene, wall);
  return dist(a, b);
}

/**
 * 壁の上の点。`along` は**始点ノードからの弧長**（直線なら距離）。
 *
 * 直線の道は触っていない——`wallPointAt`（`core/shape.ts`）のコメントが
 * 「式を組み替えるな」と言っているのと同じ理由で、DXF の出力を揺らさない。
 */
export function wallPointAtLength(scene: Scene, wall: Wall, along: number): Vec {
  const [a, b] = wallEnds(scene, wall);
  const arc = wallArc(scene, wall);
  if (!arc) {
    const total = dist(a, b);
    return total < 1e-9 ? a : add(a, mul(norm(sub(b, a)), along));
  }
  const total = bulgeArcLength(arc);
  return pointOnBulgeArc(arc, total < 1e-9 ? 0 : along / total);
}

/** 壁の上の点での進行方向（単位）。円弧では**その点の接線** */
export function wallDirAtLength(scene: Scene, wall: Wall, along: number): Vec {
  const [a, b] = wallEnds(scene, wall);
  const arc = wallArc(scene, wall);
  if (!arc) return norm(sub(b, a));
  const total = bulgeArcLength(arc);
  const t = total < 1e-9 ? 0 : along / total;
  const angle = arc.from + arc.sweep * t;
  // 反時計回りなら接線は半径を +90 度、時計回りなら −90 度
  const sign = arc.sweep >= 0 ? 1 : -1;
  return vec(-Math.sin(angle) * sign, Math.cos(angle) * sign);
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
export function addWall(
  scene: Scene,
  a: Id,
  b: Id,
  thickness: number,
  layerId: LayerId = LAYER_IDS.wall,
  bulge = 0,
): Wall | null {
  if (a === b) return null;
  const na = scene.nodes[a];
  const nb = scene.nodes[b];
  if (!na || !nb || na.levelId !== nb.levelId) return null;
  // **同じ曲線かどうかで見る。** 膨らみの絶対値で比べると、同じ 2 ノードを
  // 結ぶ「下へ膨らむ弧」と「上へ膨らむ弧」が同じ壁に見えて、レンズ形の部屋や
  // 真円の部屋が作れない。逆向きに書いた同じ弧は膨らみの符号が裏返るので、
  // 向きを揃えてから比べる
  const existing = Object.values(scene.walls).find((w) => {
    if (w.a === a && w.b === b) return w.bulge === bulge;
    if (w.a === b && w.b === a) return w.bulge === -bulge;
    return false;
  });
  if (existing) return existing;
  const id = newId('w');
  const wall: Wall = {
    id, a, b, thickness, bulge, height: null, base: 0, layerId, levelId: na.levelId, attrs: defaultAttrs(),
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
  const arc = wallArc(scene, wall);
  // **円弧は弧の上で割る。** 弦の上で割ると、新しい節点が壁から外れたところに
  // 置かれ、開口の位置（弧長で測ってある）も一緒にずれる
  const { t, point } = arc ? closestOnArc(p, arc) : closestOnSegment(p, a, b);
  const total = arc ? bulgeArcLength(arc) : dist(a, b);
  const atStart = t * total;
  if (atStart <= tolerance) return wall.a;
  if (total - atStart <= tolerance) return wall.b;

  const midId = newId('n');
  scene.nodes[midId] = { id: midId, x: point.x, y: point.y, levelId: wall.levelId };

  const originalB = wall.b;
  wall.b = midId;
  // **掃過角も割る。** 前半に元の膨らみを残すと、短くなった弦に同じ角度が
  // 乗って半径が勝手に縮む。後半を直線にすると曲がりが黙って消える
  const sweep = arc ? arc.sweep : 0;
  if (arc) wall.bulge = Math.tan((sweep * t) / 4);
  const second = addWall(
    scene, midId, originalB, wall.thickness, wall.layerId,
    arc ? Math.tan((sweep * (1 - t)) / 4) : 0,
  );
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

/** 開口の端と壁の端のあいだに残す最小の寸法 (mm) */
const OPENING_MARGIN = 20;

/** 開口を壁内に収め、他の開口と重ならない位置へ丸める。置けないなら null */
export function clampOpening(scene: Scene, wallId: Id, offset: number, width: number, ignoreId?: Id): number | null {
  const wall = scene.walls[wallId];
  if (!wall) return null;
  const total = wallLength(scene, wall);
  const margin = OPENING_MARGIN;
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


/**
 * 同じ種別の開口と重なるなら、まとめた 1 つの区間を返す。重ならないなら null。
 *
 * **壁が既に持っている 1 次元のパラメータ空間での区間マージ。** CSG でも
 * ブーリアンでもない。ワイヤーの「ブーリアンのように見える処理」はこれで足りる。
 *
 * **同じものとしか結合しない。** ドアと窓を融かすと出来たものがどちらでも
 * なくなるが、**それは種別だけの話ではない**。融かした結果は `Opening` 1 つ
 * なので、窓台・符号・張り出し・枚数・画層・素材のどれが食い違っても、
 * 片方の値が黙って消える。判定は `sameOpening`（`core/opening.ts`）に置いて
 * あり、`Opening` に欄を足すとそこが型エラーになる。
 * 融かさないときは `clampOpening` が今までどおり脇へ逃がす。
 *
 * **触れているだけでは結合しない。** 柱の無い位置に窓を 2 つ並べるのは
 * ふつうの作図で、隣に置いた瞬間に 1 つになると困る。
 */
export function mergeOpeningSpan(
  scene: Scene,
  wallId: Id,
  proto: OpeningIdentity,
  offset: number,
  width: number,
): { offset: number; width: number; absorb: Id[] } | null {
  const wall = scene.walls[wallId];
  if (!wall) return null;
  const total = wallLength(scene, wall);
  let lo = offset - width / 2;
  let hi = offset + width / 2;
  const absorb: Id[] = [];

  // 吸収するたびに区間が伸びるので、伸びなくなるまで繰り返す
  for (let pass = 0; pass < Object.keys(scene.openings).length + 1; pass++) {
    let grew = false;
    for (const other of openingsOnWall(scene, wallId)) {
      if (!sameOpening(proto, other)) continue;
      if (absorb.includes(other.id)) continue;
      const oLo = other.offset - other.width / 2;
      const oHi = other.offset + other.width / 2;
      if (oHi <= lo + MERGE_TOLERANCE || oLo >= hi - MERGE_TOLERANCE) continue;
      lo = Math.min(lo, oLo);
      hi = Math.max(hi, oHi);
      absorb.push(other.id);
      grew = true;
    }
    if (!grew) break;
  }
  if (absorb.length === 0) return null;

  // 結合した結果が壁に収まらないなら、結合しない方がまし
  if (lo < OPENING_MARGIN || hi > total - OPENING_MARGIN) return null;
  return { offset: (lo + hi) / 2, width: hi - lo, absorb };
}

/** これ以上重なったら結合する (mm)。触れているだけでは結合しない */
const MERGE_TOLERANCE = 1;

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

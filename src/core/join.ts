import { dist, type Vec } from "./geometry.ts";
import { closedPolygonOf } from "./extrude.ts";
import { polyBoolean, type PolyOp } from "./polybool.ts";
import {
  NODE_MERGE_TOLERANCE,
  openingsOnWall,
  wallEnds,
  wallsAtNode,
} from "./ops.ts";
import { dropConstraintsForWall } from "./constraintOps.ts";
import type { Shape } from "./shapes.ts";
import type { EntityRef, Id, Scene } from "./types.ts";

/**
 * 結合と合成。ワイヤー 7 枚目の「結合/合成」。
 *
 * > 複数の線分や図形を交点・端点で伸ばしたり縮めたりしながら繋いだり、
 * > **1 つの図形にまとめたり**する
 *
 * **前半（結合）と後半（合成）は別物。** 結合は端点で繋ぐだけで、開いた
 * 折れ線が相手。合成は**閉じた図形どうしのブール演算**で、`core/polybool.ts`
 * が受け持つ。ここはその 2 つの入口を並べている。
 *
 * **3D のブーリアンとは別の道具。** 3D は平面で空間を割る木（`render3d/csg.ts`）
 * で、2D には使い回せない——割る相手が面ではなく線なので、木の作り方が違う。
 */

/** 端点が一致しているとみなす距離 (mm)。ノードの統合と同じ値にそろえる */
const JOIN_TOLERANCE = NODE_MERGE_TOLERANCE;

/** 図形を「端点を持つ点の列」として見る。持たないものは null */
function endpointsOf(shape: Shape): Vec[] | null {
  if (shape.shape === "line") return [shape.a, shape.b];
  if (shape.shape === "polyline" && !shape.closed) return shape.points;
  return null;
}

/**
 * 2 つの図形を 1 本の折れ線に繋ぐ。
 *
 * 端点が一致していなければ何もしない。**伸ばして繋ぐことはしない**——
 * どちらをどれだけ伸ばすかは人が決めることで、黙って動かすと
 * 「寸法を測ったら違った」が起きる。延長ツール（E）が別にある。
 */
export function joinShapes(scene: Scene, x: Id, y: Id): boolean {
  const sx = scene.shapes[x];
  const sy = scene.shapes[y];
  if (!sx || !sy || x === y) return false;

  const px = endpointsOf(sx);
  const py = endpointsOf(sy);
  if (!px || !py || px.length < 2 || py.length < 2) return false;

  const merged = concatAtEnds(px, py);
  if (!merged) return false;

  delete scene.shapes[y];
  scene.shapes[x] = {
    id: x,
    shape: "polyline",
    layerId: sx.layerId,
    levelId: sx.levelId,
    attrs: { ...sx.attrs },
    points: merged,
    // 両端が重なったら閉じる。四角形を 4 本の線から作ったときに効く
    closed:
      merged.length > 3 &&
      dist(merged[0], merged[merged.length - 1]) <= JOIN_TOLERANCE,
  };
  if (scene.shapes[x].shape === "polyline" && scene.shapes[x].closed) {
    const p = scene.shapes[x];
    if (p.shape === "polyline") p.points = p.points.slice(0, -1);
  }
  return true;
}

/** 4 通りの端の合わせ方を試し、一致するものがあれば繋いだ点列を返す */
function concatAtEnds(a: Vec[], b: Vec[]): Vec[] | null {
  const near = (p: Vec, q: Vec): boolean => dist(p, q) <= JOIN_TOLERANCE;
  const rb = [...b].reverse();
  if (near(a[a.length - 1], b[0])) return [...a, ...b.slice(1)];
  if (near(a[a.length - 1], b[b.length - 1])) return [...a, ...rb.slice(1)];
  if (near(a[0], b[b.length - 1])) return [...b, ...a.slice(1)];
  if (near(a[0], b[0])) return [...rb, ...a.slice(1)];
  return null;
}

/**
 * 一直線に並んだ 2 本の壁を 1 本にする。
 *
 * **共有ノードに取り付く壁がちょうど 2 本のときだけ。** 3 本以上なら
 * そこは本物の角で、1 本にすると残りの壁が宙に浮く。
 *
 * 開口は位置を付け替えて引き継ぐ。`splitWall` の逆を手でやる形で、
 * 消える側の壁に乗っていた開口は、残る壁の座標系へ offset をずらす。
 */
export function joinWalls(scene: Scene, x: Id, y: Id): boolean {
  const wx = scene.walls[x];
  const wy = scene.walls[y];
  if (!wx || !wy || x === y) return false;
  if (wx.thickness !== wy.thickness) return false;

  const shared = sharedNode(wx, wy);
  if (!shared) return false;
  if (wallsAtNode(scene, shared).length !== 2) return false;
  if (!collinear(scene, x, y)) return false;

  const farEnd = wy.a === shared ? wy.b : wy.a;
  const lenX = dist(...wallEnds(scene, wx));
  const lenY = dist(...wallEnds(scene, wy));
  // 開口の offset は壁の始点（a）から測る。**どちら側に伸ばすかで
  // 既存の開口まで動く**ので、2 つの場合を分けて書く
  const sharedAtA = wx.a === shared;
  const ySharedAtA = wy.a === shared;
  const fromShared = (offset: number): number =>
    ySharedAtA ? offset : lenY - offset;
  const moved = openingsOnWall(scene, y);

  if (sharedAtA) {
    // 新しい始点は相手の遠い端。もとの開口は相手の長さぶん後ろへずれる
    for (const op of openingsOnWall(scene, x)) op.offset += lenY;
    for (const op of moved) {
      op.offset = lenY - fromShared(op.offset);
      op.wallId = x;
    }
  } else {
    // 始点は変わらない。相手の開口だけを、こちらの長さぶん先へ置く
    for (const op of moved) {
      op.offset = lenX + fromShared(op.offset);
      op.wallId = x;
    }
  }

  dropConstraintsForWall(scene, y);
  delete scene.walls[y];
  if (sharedAtA) wx.a = farEnd;
  else wx.b = farEnd;
  // 使われなくなった共有ノードを落とす
  if (wallsAtNode(scene, shared).length === 0) delete scene.nodes[shared];
  return true;
}

function sharedNode(a: { a: Id; b: Id }, b: { a: Id; b: Id }): Id | null {
  if (a.a === b.a || a.a === b.b) return a.a;
  if (a.b === b.a || a.b === b.b) return a.b;
  return null;
}

/** 2 本の壁が一直線に並んでいるか。外積で見る */
function collinear(scene: Scene, x: Id, y: Id): boolean {
  const [ax, bx] = wallEnds(scene, scene.walls[x]);
  const [ay, by] = wallEnds(scene, scene.walls[y]);
  const u = { x: bx.x - ax.x, y: bx.y - ax.y };
  const v = { x: by.x - ay.x, y: by.y - ay.y };
  const cross = u.x * v.y - u.y * v.x;
  const scale = Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y);
  // 角度にして約 0.06 度。図面の精度では「まっすぐ」と見てよい
  return scale > 1e-9 && Math.abs(cross) / scale < 1e-3;
}

/** 2 つの実体を繋ぐ。種別が違えば何もしない */
export function joinEntities(
  scene: Scene,
  x: EntityRef,
  y: EntityRef,
): boolean {
  if (x.type === "shape" && y.type === "shape")
    return joinShapes(scene, x.id, y.id);
  if (x.type === "wall" && y.type === "wall")
    return joinWalls(scene, x.id, y.id);
  return false;
}

/**
 * 閉じた図形どうしの合成・切り欠き・交差。
 *
 * **1 つめを母体にして、残りを順に掛ける。** できた母体の id を返す。
 * 掛け合わせた相手は**図面から消える**（3D のブーリアンが相手を母体へ
 * しまい込むのと違い、2D は結果の形がそのまま輪郭になるので、戻す道が要らない）。
 *
 * **1 本の輪郭にならない組み合わせは、何も変えずに null を返す。**
 * 穴ができる形も、2 つに割れる形も、`Shape` では表せない。
 * 呼んだ側が理由を画面に出す。
 */
export function combineShapes(
  scene: Scene,
  ids: readonly Id[],
  op: PolyOp,
): Id | null {
  if (ids.length < 2) return null;
  const polys: Vec[][] = [];
  for (const id of ids) {
    const poly = closedPolygonOf(scene, id);
    if (!poly) return null;
    polys.push(poly);
  }

  let merged = polys[0];
  for (let i = 1; i < polys.length; i++) {
    const next = polyBoolean(merged, polys[i], op);
    if (!next) return null;
    merged = next;
  }

  const host = scene.shapes[ids[0]];
  if (!host) return null;
  for (const id of ids.slice(1)) delete scene.shapes[id];
  scene.shapes[ids[0]] = {
    id: ids[0],
    shape: "polyline",
    layerId: host.layerId,
    levelId: host.levelId,
    attrs: { ...host.attrs },
    points: merged,
    closed: true,
  };
  return ids[0];
}

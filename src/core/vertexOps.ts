import { closestOnSegment, dist, type Vec } from './geometry.ts';
import type { Shape, ShapeKind } from './shapes.ts';
import type { Id, Scene } from './types.ts';

/**
 * 図形の頂点編集。
 *
 * **`SHAPE_GEOMETRY` には足さない。** `Record<ShapeKind, …>` に足すと、
 * 文字・点・寸法・円・円弧にも無意味な実装を 5 つ書かされ、README の
 * 「図形を 1 種類足すときに書くのは 4 箇所」が 5 箇所になる。
 * 代わりに `switch` の `default` にして、**`CURVES_INTO` と同じ形の表**
 * （`tests/shapes.test.ts` の `HAS_VERTICES`）をテストに置いて塞ぐ。
 *
 * **`SHAPE_GEOMETRY.vertices` は使わない。** あれは「代表点。範囲選択と
 * 図面範囲に使う」と宣言されていて、円弧と円では折れ線近似や四分点を返す。
 * しかもポリラインでは**内部配列をそのまま返す**ので、編集に使うと
 * undo（`structuredClone` 前提）と噛み合わない。
 *
 * **壁の頂点はここに来ない。** 壁の角はノード（`Node`）で、ピック・スナップ・
 * ハンドル描画・ドラッグ・統合・分割が**すべて既にある**。同じ道に乗せる。
 */

/**
 * 動かせる頂点。持たない種別は空。
 *
 * 円弧・円は「真の頂点」が無い（編集すべきは中心・半径・角度で、
 * それはプロパティ欄の仕事）。注釈のたぐいも持たない。
 */
export function editableVertices(shape: Shape): Vec[] {
  switch (shape.shape) {
    case 'line':
      return [shape.a, shape.b];
    case 'polyline':
      // **複製して返す。** 呼ぶ側が触っても図形が壊れない
      return shape.points.map((p) => ({ ...p }));
    default:
      return [];
  }
}

/** その種別が頂点編集に答えるか。表（テスト）と突き合わせるために出す */
export const hasEditableVertices = (kind: ShapeKind): boolean =>
  kind === 'line' || kind === 'polyline';

/** 頂点を動かした図形。番号が範囲外なら null */
export function moveVertex(shape: Shape, index: number, to: Vec): Shape | null {
  if (shape.shape === 'line') {
    if (index === 0) return { ...shape, a: { ...to } };
    if (index === 1) return { ...shape, b: { ...to } };
    return null;
  }
  if (shape.shape !== 'polyline') return null;
  if (index < 0 || index >= shape.points.length) return null;
  const points = shape.points.map((p, i) => (i === index ? { ...to } : { ...p }));
  return { ...shape, points };
}

/**
 * 辺の上に頂点を足した図形。
 *
 * 線は足した時点で折れ線になる。`edgeIndex` は `editableVertices` の
 * 番号で、その点と次の点のあいだに入る（閉じた折れ線では最後の辺も含む）。
 */
export function insertVertex(shape: Shape, edgeIndex: number, at: Vec): Shape | null {
  if (shape.shape === 'line') {
    if (edgeIndex !== 0) return null;
    return {
      id: shape.id,
      shape: 'polyline',
      layerId: shape.layerId,
      levelId: shape.levelId,
      attrs: { ...shape.attrs },
      points: [{ ...shape.a }, { ...at }, { ...shape.b }],
      closed: false,
    };
  }
  if (shape.shape !== 'polyline') return null;
  const edges = shape.closed ? shape.points.length : shape.points.length - 1;
  if (edgeIndex < 0 || edgeIndex >= edges) return null;
  const points = shape.points.map((p) => ({ ...p }));
  points.splice(edgeIndex + 1, 0, { ...at });
  return { ...shape, points };
}

/**
 * 頂点を落とした図形。
 *
 * **2 点を割ると保存して読み戻したときに図形が消える**
 * （`shapeRead.ts` が `points.length >= 2` を要求している）ので、
 * 2 点のポリラインからは落とさない。線は端点を落とせない。
 */
export function removeVertex(shape: Shape, index: number): Shape | null {
  if (shape.shape !== 'polyline') return null;
  if (index < 0 || index >= shape.points.length) return null;
  if (shape.points.length <= 2) return null;
  const points = shape.points.filter((_, i) => i !== index).map((p) => ({ ...p }));
  // 3 点が 2 点になったら、閉じていても閉じようがない
  return { ...shape, points, closed: points.length > 2 && shape.closed };
}

export interface VertexHit {
  shapeId: Id;
  index: number;
}

/** カーソルに近い頂点。`pickAt` は汚さず別の入口にする */
export function pickVertex(scene: Scene, p: Vec, tolerance: number): VertexHit | null {
  let best: (VertexHit & { d: number }) | null = null;
  for (const shape of Object.values(scene.shapes)) {
    const layer = scene.layers[shape.layerId];
    if (layer && (!layer.visible || layer.locked)) continue;
    const vs = editableVertices(shape);
    for (let index = 0; index < vs.length; index++) {
      const d = dist(p, vs[index]);
      if (d > tolerance) continue;
      if (!best || d < best.d) best = { shapeId: shape.id, index, d };
    }
  }
  return best === null ? null : { shapeId: best.shapeId, index: best.index };
}

export interface EdgeHit {
  shapeId: Id;
  /** `editableVertices` の番号で、その点と次の点のあいだ */
  edgeIndex: number;
  /** 辺の上の、カーソルにいちばん近い点 */
  at: Vec;
}

/** カーソルに近い辺。頂点を足す位置を決めるのに使う */
export function pickEdge(scene: Scene, p: Vec, tolerance: number): EdgeHit | null {
  let best: (EdgeHit & { d: number }) | null = null;
  for (const shape of Object.values(scene.shapes)) {
    const layer = scene.layers[shape.layerId];
    if (layer && (!layer.visible || layer.locked)) continue;
    const vs = editableVertices(shape);
    if (vs.length < 2) continue;
    const closed = shape.shape === 'polyline' && shape.closed;
    const edges = closed ? vs.length : vs.length - 1;
    for (let i = 0; i < edges; i++) {
      const a = vs[i];
      const b = vs[(i + 1) % vs.length];
      if (dist(a, b) < 1e-9) continue;
      const hit = closestOnSegment(p, a, b);
      if (hit.dist > tolerance) continue;
      if (!best || hit.dist < best.d) {
        best = { shapeId: shape.id, edgeIndex: i, at: hit.point, d: hit.dist };
      }
    }
  }
  return best ? { shapeId: best.shapeId, edgeIndex: best.edgeIndex, at: best.at } : null;
}

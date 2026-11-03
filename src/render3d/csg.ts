import { dot3, scale3 } from './mat4.ts';
import type { Face3 } from './mesh.ts';
import { splitFace, type Plane3D, type SplitResult } from './bsp.ts';

/**
 * ブーリアン（合成・切り欠き・交差）。**22 段で入れた面を割る木をそのまま使う。**
 *
 * 考え方は 1 つだけ——**「相手の立体の内側にある面を捨てる」**。
 * 木は空間を平面で二分しているので、面を木に落としていけば
 * 内側か外側かが分かる。合成・切り欠き・交差の 3 つは、
 * **どちらを裏返してから捨てるか**が違うだけで、仕掛けは同じ。
 *
 * **閉じた立体しか扱えない。** 開いた面の集まりでは「内側」が決まらない。
 * MiniCAD の立体はどれも押し出しか回転体で閉じている（水密であることは
 * `tests/solid.test.ts` が稜線の数で見ている）。
 *
 * **塗る順の木（`bsp.ts`）とは別の木。** あちらは視点から奥→手前に吐くための
 * もので、面を裏返したり切り落としたりしない。割る処理だけを共有している。
 */

export interface CsgNode {
  plane: Plane3D;
  /** この平面に乗っている面 */
  on: Face3[];
  front: CsgNode | null;
  back: CsgNode | null;
}

/** 面を裏返す。並びを逆にして法線も逆へ */
const flip = (f: Face3): Face3 => ({
  ...f,
  points: [...f.points].reverse(),
  normal: scale3(f.normal, -1),
});

/** 平面を裏返す */
const flipPlane = (p: Plane3D): Plane3D => ({ n: scale3(p.n, -1), d: -p.d });

const planeOf = (face: Face3): Plane3D => ({ n: face.normal, d: dot3(face.normal, face.points[0]) });

/**
 * 面を木に足す。**最初の 1 枚が節の平面になる。**
 *
 * 塗る順の木と違って候補を選ばない。CSG では木の形より
 * 「どの面がどちら側か」が合っていることが大事で、`clipTo` が何度も走るので、
 * 建てるのを軽くしておくほうが効く。
 */
export function csgBuild(node: CsgNode | null, faces: readonly Face3[]): CsgNode | null {
  if (faces.length === 0) return node;
  const tree: CsgNode = node ?? { plane: planeOf(faces[0]), on: [], front: null, back: null };

  const out: SplitResult = { front: [], back: [], on: [] };
  for (const f of faces) splitFace(f, tree.plane, out);

  // **木に入れるときは、乗っている面を向きで分けない。** どちら向きでも
  // この節の平面の持ち物で、内と外の判断は `csgClipFaces` がするため。
  // 分けるのは削るときだけ（そちらは分けないと接した面で狂う）
  for (const f of out.on) tree.on.push(f);
  if (out.front.length > 0) tree.front = csgBuild(tree.front, out.front);
  if (out.back.length > 0) tree.back = csgBuild(tree.back, out.back);
  return tree;
}

/** 木に入っている面を全部集める */
export function csgFaces(node: CsgNode | null): Face3[] {
  if (!node) return [];
  return [...node.on, ...csgFaces(node.front), ...csgFaces(node.back)];
}

/** 木ごと裏返す。内と外が入れ替わる */
export function csgInvert(node: CsgNode | null): void {
  if (!node) return;
  node.plane = flipPlane(node.plane);
  node.on = node.on.map(flip);
  csgInvert(node.front);
  csgInvert(node.back);
  const swap = node.front;
  node.front = node.back;
  node.back = swap;
}

/**
 * 面の集まりから、**この立体の内側にある部分を落とす**。
 *
 * 裏の枝が無いところは「外側」なので残す。表の枝が無いところは
 * 「内側」なので捨てる——節の平面の表側に出た時点で、もうこの立体の外。
 */
export function csgClipFaces(node: CsgNode | null, faces: readonly Face3[]): Face3[] {
  if (!node) return [...faces];
  const out: SplitResult = { front: [], back: [], on: [] };
  for (const f of faces) splitFace(f, node.plane, out);
  // 乗っている面は向きで振り分ける（`csgBuild` と同じ規則）
  for (const f of out.on) {
    if (dot3(f.normal, node.plane.n) > 0) out.front.push(f);
    else out.back.push(f);
  }
  const front = csgClipFaces(node.front, out.front);
  // 裏の枝が無ければ、そこは立体の内側。捨てる
  const back = node.back ? csgClipFaces(node.back, out.back) : [];
  return [...front, ...back];
}

/** 木の持っている面から、相手の内側にある部分を落とす */
export function csgClipTo(node: CsgNode | null, other: CsgNode | null): void {
  if (!node) return;
  node.on = csgClipFaces(other, node.on);
  csgClipTo(node.front, other);
  csgClipTo(node.back, other);
}

export type BooleanOp = 'unite' | 'subtract' | 'intersect';

export const BOOLEAN_LABELS: Record<BooleanOp, string> = {
  unite: '合成',
  subtract: '切り欠き',
  intersect: '交差',
};

/**
 * 2 つの立体の面からブーリアンの結果を作る。
 *
 * 手順はどれも同じ形で、**裏返す場所が違うだけ**:
 *
 * | | 手順 |
 * |---|---|
 * | 合成 | 互いの内側を捨てて、残りを足す |
 * | 切り欠き | **引く側を裏返してから**同じことをする（内と外が入れ替わる） |
 * | 交差 | **自分を裏返してから**同じことをする |
 *
 * 境目で重なった面は、**向きが逆のものを捨てる**ことで消える——
 * 貼り合わせた箱の継ぎ目が残らないのはこのため。
 */
export function csgOperate(a: readonly Face3[], b: readonly Face3[], op: BooleanOp): Face3[] {
  if (a.length === 0) return op === 'unite' ? [...b] : [];
  if (b.length === 0) return op === 'intersect' ? [] : [...a];

  const ta = csgBuild(null, a);
  const tb = csgBuild(null, b);
  if (!ta || !tb) return [...a];

  if (op === 'intersect') {
    // **交差だけは手順が違う。** 自分を裏返してから相手を削り、相手を裏返して
    // から自分を削る。合成の手順に裏返しを足しただけでは、離れた 2 つが
    // 交差したことになる（実際にそうなって見つけた）
    csgInvert(ta);
    csgClipTo(tb, ta);
    csgInvert(tb);
    csgClipTo(ta, tb);
    csgClipTo(tb, ta);
    csgBuild(ta, csgFaces(tb));
    csgInvert(ta);
    return csgFaces(ta);
  }

  // 合成と切り欠きは同じ手順で、**切り欠きは自分を裏返してから**入る
  if (op === 'subtract') csgInvert(ta);
  csgClipTo(ta, tb);
  csgClipTo(tb, ta);
  // **相手の表面のうち、自分の中に埋もれた部分を落とす。**
  // 裏返して挟むのが、同じ仕掛けで内側だけを狙う常套手段
  csgInvert(tb);
  csgClipTo(tb, ta);
  csgInvert(tb);

  csgBuild(ta, csgFaces(tb));
  if (op === 'subtract') csgInvert(ta);
  return csgFaces(ta);
}

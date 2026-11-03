import { add3, dot3, scale3, sub3, type Vec3 } from './mat4.ts';
import type { Face3 } from './mesh.ts';

/**
 * 面を割って木に入れ、視点から奥→手前の順に吐く（BSP）。
 *
 * **なぜ要るのか。** いまの塗りは面の重心の深さで並べている。重心は面を 1 点に
 * 潰すので、**互いに跨いだ 2 枚**では必ずどちらかが嘘になる。サンプル間取りでも
 * 画素の 1〜2% が「塗られた色」と「本当に手前の面」で食い違っていて、
 * 利用者が自由に置くソリッドを交差させると 10〜13% まで上がる。
 *
 * **面を割れば、重なった面の組は無くなる。** 木の各節が 1 枚の平面で空間を
 * 二分し、またぐ面はその場で 2 枚に切る。視点がどちら側にあるかで
 * 「奥の枝 → 節の面 → 手前の枝」と辿れば、**どの視点でも必ず奥から塗れる**。
 *
 * **出すのは今と同じ `Face3` の列。** `paint` は並べ替えの出どころが
 * 変わるだけで、`ctx` に頼むこと（多角形の fill と stroke）は何も変わらない。
 * 拾う側（`ray.ts`）は実際の距離を見ているので**無改修**。
 *
 * **木は毎フレーム建て直さない。** 面の顔ぶれが変わったときだけ建て直す
 * （`viewer.ts`）。辿るのは視点が動くたびだが、こちらは木を歩くだけ。
 */

/** `dot(n, p) = d` の平面 */
export interface Plane3D {
  n: Vec3;
  d: number;
}

export interface BspNode {
  plane: Plane3D;
  /** この平面に乗っている面 */
  on: Face3[];
  front: BspNode | null;
  back: BspNode | null;
}

/**
 * 平面の表裏を分ける閾値 (mm)。
 *
 * 世界の単位は mm で、図面は 10^4 mm の広がりを持つ。0.01mm は作図の
 * 丸め（最小の刻みが 1mm）より細かく、倍精度の誤差よりはるかに粗い。
 */
const EPS = 0.01;

const planeOf = (face: Face3): Plane3D => ({ n: face.normal, d: dot3(face.normal, face.points[0]) });

/** 点が平面のどちら側か。+1 表、-1 裏、0 上 */
const sideOf = (plane: Plane3D, p: Vec3): number => {
  const v = dot3(plane.n, p) - plane.d;
  return v > EPS ? 1 : v < -EPS ? -1 : 0;
};

/** 切り出した断片。**元の面を覚えておく**ので、どこから来たかを辿れる */
function fragment(face: Face3, points: Vec3[]): Face3 | null {
  const ring = points.filter((p, i) => {
    const q = points[(i + points.length - 1) % points.length];
    return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) > EPS;
  });
  if (ring.length < 3) return null;
  // **法線は元のまま。** 断片は元と同じ平面にあるので計算し直す意味が無く、
  // 細い切れ端から出し直すと向きが飛ぶ
  return { ...face, points: ring, origin: face.origin ?? face };
}

export interface SplitResult {
  front: Face3[];
  back: Face3[];
  /** 平面に乗っている面。向きは問わない */
  on: Face3[];
}

/**
 * 面 1 枚を平面で割る。またがっていなければ、そのまま片側へ入れる。
 *
 * またぐ辺では交点を 1 つ作り、**表側と裏側の両方の輪に入れる**。
 * こうすると切り口が合い、間に隙間が空かない。
 */
export function splitFace(face: Face3, plane: Plane3D, out: SplitResult): void {
  const pts = face.points;
  const sides = pts.map((p) => sideOf(plane, p));
  const hasFront = sides.some((s) => s > 0);
  const hasBack = sides.some((s) => s < 0);

  if (!hasFront && !hasBack) {
    out.on.push(face);
    return;
  }
  if (!hasBack) {
    out.front.push(face);
    return;
  }
  if (!hasFront) {
    out.back.push(face);
    return;
  }

  const front: Vec3[] = [];
  const back: Vec3[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const sa = sides[i];
    const sb = sides[(i + 1) % pts.length];
    if (sa >= 0) front.push(a);
    if (sa <= 0) back.push(a);
    if (sa * sb < 0) {
      const ab = sub3(b, a);
      const t = (plane.d - dot3(plane.n, a)) / dot3(plane.n, ab);
      const hit = add3(a, scale3(ab, t));
      front.push(hit);
      back.push(hit);
    }
  }
  const f = fragment(face, front);
  const b = fragment(face, back);
  if (f) out.front.push(f);
  if (b) out.back.push(b);
}

/**
 * 割る平面を選ぶ。**候補をいくつか試して、いちばん割れ目の少ないものを採る。**
 *
 * 全部の面を候補にすると O(n²) になる。建築の面は軸に揃っているものが多く、
 * 少し見ればよい候補が見つかるので、等間隔に 12 枚だけ試す。
 */
const CANDIDATES = 12;

/** 割れ目 1 つの重み。**割るほうが偏りより高くつく**（面が増えるので） */
const SPLIT_COST = 8;

function pickSplitter(faces: readonly Face3[]): number {
  let best = 0;
  let bestScore = Infinity;
  const step = Math.max(1, Math.floor(faces.length / CANDIDATES));
  for (let i = 0; i < faces.length; i += step) {
    const plane = planeOf(faces[i]);
    let front = 0;
    let back = 0;
    let split = 0;
    for (let j = 0; j < faces.length; j++) {
      if (j === i) continue;
      let hasFront = false;
      let hasBack = false;
      for (const p of faces[j].points) {
        const s = sideOf(plane, p);
        if (s > 0) hasFront = true;
        else if (s < 0) hasBack = true;
      }
      if (hasFront && hasBack) split += 1;
      else if (hasFront) front += 1;
      else if (hasBack) back += 1;
    }
    const score = Math.abs(front - back) + split * SPLIT_COST;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** 面を木に入れる。空なら null */
export function buildBsp(faces: readonly Face3[]): BspNode | null {
  if (faces.length === 0) return null;

  const pivot = pickSplitter(faces);
  const plane = planeOf(faces[pivot]);
  const out: SplitResult = { front: [], back: [], on: [] };
  for (let i = 0; i < faces.length; i++) {
    if (i === pivot) out.on.push(faces[i]);
    else splitFace(faces[i], plane, out);
  }
  return {
    plane,
    on: out.on,
    front: buildBsp(out.front),
    back: buildBsp(out.back),
  };
}

/**
 * 視点から見て奥から手前の順に並べる。
 *
 * 視点が平面の表側にあるなら、**裏の枝が奥**。節に乗っている面はその間に入る
 * （視点と同じ平面にある面は、どちらの枝とも重ならない）。
 */
export function bspOrder(node: BspNode | null, eye: Vec3): Face3[] {
  const out: Face3[] = [];
  walk(node, eye, out);
  return out;
}

function walk(node: BspNode | null, eye: Vec3, out: Face3[]): void {
  if (!node) return;
  if (dot3(node.plane.n, eye) - node.plane.d > 0) {
    walk(node.back, eye, out);
    for (const f of node.on) out.push(f);
    walk(node.front, eye, out);
  } else {
    walk(node.front, eye, out);
    for (const f of node.on) out.push(f);
    walk(node.back, eye, out);
  }
}

/** 木に入っている面の数。割れ目でどれだけ増えたかを見るのに使う */
export function bspSize(node: BspNode | null): number {
  if (!node) return 0;
  return node.on.length + bspSize(node.front) + bspSize(node.back);
}

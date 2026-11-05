import {
  closestOnSegment,
  dist,
  lerp,
  pointInPolygon,
  segmentIntersection,
  signedArea,
  sub,
  cross,
  type Vec,
} from "./geometry.ts";

/**
 * 2D の多角形のブール演算——合成・切り欠き・交差（ワイヤー 7 枚目
 * 「複数の線分や図形を…1 つの図形にまとめたりする」）。
 *
 * **辺を分けて、内外で選んで、つなぎ直す。** 交点で両方の輪郭を切り、
 * 切れ端ごとに「相手の内か外か境界か」を見て、演算に応じて採る辺を決め、
 * 最後に頭と尻をつないで環にする。
 *
 * **退化を正面から扱う。** 間取りの図形は**辺を共有する**のが普通
 * （柱が壁にぴったり付く、部屋が隣り合う）ので、
 * 「辺が重なる」「頂点が辺の上に乗る」「接するだけ」は例外ではなく日常。
 * 交点だけを追う作り（グライナー・ホーマン法）はここで崩れるので、
 * **境界を第 3 の状態として持つ**作りにしてある。
 *
 * **穴は持たない。** 結果が 2 つ以上の環になる組み合わせ（ドーナツ、
 * 離れた 2 つ）は `null` を返す。`Shape` にも `Fixture.outline` にも穴の
 * 置き場が無いので、**黙って嘘の形を作るより断る**——自己交差した形を
 * 断る `extrude.ts` と同じ作法。呼んだ側が理由を画面に出す。
 */

export const POLY_OPS = ["unite", "subtract", "intersect"] as const;

export type PolyOp = (typeof POLY_OPS)[number];

/** これより近い点は同じ点とみなす (mm) */
const EPS = 1e-7;

/** 環をつなぐときの突き合わせ。0.1 ナノメートルの格子に丸めて鍵にする */
const KEY_SCALE = 1e7;

const keyOf = (p: Vec): string =>
  `${Math.round(p.x * KEY_SCALE)},${Math.round(p.y * KEY_SCALE)}`;

/** 辺の切れ端。向きを持つ */
interface Piece {
  a: Vec;
  b: Vec;
}

/**
 * 2 つの単純多角形のブール演算。**結果が 1 本の環にならなければ `null`。**
 *
 * 入れる多角形は単純（自己交差なし）で、向きは問わない——中で反時計回りに
 * 揃える。返すのも反時計回り。
 */
export function polyBoolean(
  a: readonly Vec[],
  b: readonly Vec[],
  op: PolyOp,
): Vec[] | null {
  const A = ccw(a);
  const B = ccw(b);
  if (!A || !B) return null;

  const splitA = splitAgainst(A, B);
  const splitB = splitAgainst(B, A);

  const pieces: Piece[] = [];
  for (const piece of edgesOf(splitA)) {
    const side = classify(midOf(piece), B);
    if (keepFromHost(side, op, () => sameDirection(piece, splitB))) {
      pieces.push(piece);
    }
  }
  for (const piece of edgesOf(splitB)) {
    const side = classify(midOf(piece), A);
    // **境界が重なる辺は母体の側だけ採る。** 両方採ると同じ辺が 2 本になる
    if (side === "on") continue;
    if (op === "unite" && side === "out") pieces.push(piece);
    else if (op === "intersect" && side === "in") pieces.push(piece);
    // 切り欠きでは、相手の内側の辺を**逆向きに**使う（穴の縁をなぞる）
    else if (op === "subtract" && side === "in")
      pieces.push({ a: piece.b, b: piece.a });
  }

  return chain(pieces);
}

/** 母体（1 つめの多角形）の辺を採るか */
function keepFromHost(side: Side, op: PolyOp, sameDir: () => boolean): boolean {
  if (side === "on") {
    // 重なった辺。**向きが揃っていれば「同じ外側」、逆なら「背中合わせ」**
    return op === "subtract" ? !sameDir() : sameDir();
  }
  if (op === "unite") return side === "out";
  if (op === "intersect") return side === "in";
  return side === "out"; // subtract
}

type Side = "in" | "out" | "on";

/** 切れ端の真ん中が、相手の内か外か境界か */
function classify(mid: Vec, other: readonly Vec[]): Side {
  if (onBoundary(mid, other)) return "on";
  return pointInPolygon(mid, other as Vec[]) ? "in" : "out";
}

function onBoundary(p: Vec, poly: readonly Vec[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (closestOnSegment(p, a, b).dist < EPS) return true;
  }
  return false;
}

/** 相手の輪郭に、この切れ端と**同じ向きの**辺があるか */
function sameDirection(piece: Piece, other: readonly Vec[]): boolean {
  const mid = midOf(piece);
  const dir = sub(piece.b, piece.a);
  for (let i = 0; i < other.length; i++) {
    const a = other[i];
    const b = other[(i + 1) % other.length];
    if (closestOnSegment(mid, a, b).dist >= EPS) continue;
    const d = sub(b, a);
    // 平行で、かつ同じ向き
    if (Math.abs(cross(dir, d)) < EPS * 10 && dir.x * d.x + dir.y * d.y > 0) {
      return true;
    }
  }
  return false;
}

const midOf = (piece: Piece): Vec => lerp(piece.a, piece.b, 0.5);

function* edgesOf(poly: readonly Vec[]): Generator<Piece> {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (dist(a, b) > EPS) yield { a, b };
  }
}

/**
 * 相手と交わるところで辺を切る。
 *
 * **交点だけで足りる。** 一度は「相手の頂点をこちらの辺へ落とした点」も
 * 切れ目にしていたが、**消しても結果が 1 つも変わらなかった**ので外した。
 * 理由はこう:
 *
 * `segmentIntersection` は端点どうしの接触も返す（`t`・`u` が 0 や 1 でもよい）。
 * だから相手の頂点がこちらの辺に乗っているとき、
 *
 * - その頂点から**横へ出る辺が 1 本でもあれば**、その辺との交点として見つかる
 * - **両隣とも重なっている**なら、それは一直線の途中にある冗長な頂点で、
 *   そこで切っても**両側が同じ判定になる**（切る意味が無い）
 *
 * T 字も、辺の一部の重なりも、前者で捕まる。
 */
function splitAgainst(poly: readonly Vec[], other: readonly Vec[]): Vec[] {
  const out: Vec[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    out.push(a);
    const length = dist(a, b);
    if (length < EPS) continue;
    const margin = EPS / length;

    const ts: number[] = [];
    const m = other.length;
    for (let j = 0; j < m; j++) {
      const c = other[j];
      const d = other[(j + 1) % m];
      const hit = segmentIntersection(a, b, c, d);
      if (hit) ts.push(closestOnSegment(hit, a, b).t);
    }
    ts.sort((x, y) => x - y);
    let last = 0;
    for (const t of ts) {
      if (t > last + margin && t < 1 - margin) {
        out.push(lerp(a, b, t));
        last = t;
      }
    }
  }
  return out;
}

/**
 * 切れ端をつないで 1 本の環にする。**2 本以上になったら `null`。**
 *
 * 穴（ドーナツ）も、離れた 2 つも、ここで 2 本以上の環になる。
 * どちらも 1 本の輪郭では表せないので断る。
 */
function chain(pieces: readonly Piece[]): Vec[] | null {
  if (pieces.length < 3) return null;
  const byStart = new Map<string, Piece[]>();
  for (const piece of pieces) {
    const k = keyOf(piece.a);
    const list = byStart.get(k);
    if (list) list.push(piece);
    else byStart.set(k, [piece]);
  }

  const used = new Set<Piece>();
  const loop: Vec[] = [];
  let current = pieces[0];
  const startKey = keyOf(current.a);
  for (;;) {
    if (used.has(current)) return null;
    used.add(current);
    loop.push(current.a);
    const nextKey = keyOf(current.b);
    if (nextKey === startKey) break;
    const candidates = (byStart.get(nextKey) ?? []).filter((p) => !used.has(p));
    // **分かれ道があったら断る。** どちらへ進むかで別の形になる＝
    // 1 本の輪郭では表せていない
    if (candidates.length !== 1) return null;
    current = candidates[0];
  }
  // 全部使い切っていなければ、別の環が残っている（穴か、離れた塊）
  if (used.size !== pieces.length) return null;

  const cleaned = dropCollinear(loop);
  if (cleaned.length < 3) return null;
  if (signedArea(cleaned) < EPS) return null;
  return cleaned;
}

/** 一直線に並んだ途中の点を落とす。形は変わらない */
function dropCollinear(poly: readonly Vec[]): Vec[] {
  const n = poly.length;
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const cur = poly[i];
    const next = poly[(i + 1) % n];
    const d1 = sub(cur, prev);
    const d2 = sub(next, cur);
    const scale = Math.max(dist(prev, cur), dist(cur, next), 1);
    if (Math.abs(cross(d1, d2)) < EPS * scale) continue;
    out.push(cur);
  }
  return out;
}

/**
 * 反時計回りに揃え、**座標をナノメートルの格子に丸める。** 面積が無ければ null。
 *
 * **丸めるのが効く。** 計算で作った輪郭には浮動小数の屑が乗る——
 * 90 度回した箱との交差で `500` が `500.0000000000001` になる、といった具合。
 * そのままだと「重なっているはずの辺」がごくわずかに傾き、境界として
 * 扱えずに環がつながらない（**実際に切り分けた立体の平面で起きた**）。
 *
 * 1e-6 mm はナノメートルの単位で、建築の図面では意味を持たない桁。
 * ここで落としても失うものが無く、**退化を本当の退化として扱える**ようになる。
 */
function ccw(poly: readonly Vec[]): Vec[] | null {
  if (poly.length < 3) return null;
  const snapped = poly.map((p) => ({ x: snap(p.x), y: snap(p.y) }));
  const area = signedArea(snapped);
  if (Math.abs(area) < 1) return null;
  return area < 0 ? snapped.reverse() : snapped;
}

const snap = (v: number): number => Math.round(v * SNAP_SCALE) / SNAP_SCALE;

/** 丸めの細かさ。1e-6 mm ＝ ナノメートル */
const SNAP_SCALE = 1e6;

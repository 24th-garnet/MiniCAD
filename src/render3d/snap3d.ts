import { add3, scale3, sub3, type Vec3 } from "./mat4.ts";
import { projectPoint, type View } from "./camera.ts";
import type { Face3 } from "./mesh.ts";
import type { Vec } from "../core/geometry.ts";

/**
 * 3D の吸着（オブジェクトスナップ）。**2D とは別の仕組み。**
 *
 * これまで 3D で狙えるのは「床の格子」と「指した面の上の点」までで、
 * **立体の角には吸い付きませんでした**。角に合わせて何かを置こうとすると、
 * 視点を回しながら目測で近づけるしかありません。
 *
 * ## なぜ 2D の `core/snap.ts` を使い回さないか
 *
 * 2D の吸着は「世界の mm での距離」で決めます。3D では使えません——
 * **同じ 100mm でも、手前の壁と奥の壁では画面上の近さがまるで違う**からです。
 * 奥にある角に、手前の角より強く吸い寄せられることになります。
 * だから**画面の画素で測り**、候補を画面に投影してから選びます。
 *
 * ## 倣い先（AutoCAD の 3D オブジェクトスナップ）
 *
 * ワイヤーに記述が無いので、一般的な CAD に倣いました。AutoCAD は 3D の
 * 吸着を 2D とは**別のトグル・別の変数**（`3DOSMODE`）にし、**モードを
 * 少数に絞り**、候補が複数あるときは **Tab で送れる**ようにしています。
 * ここも同じ 3 点を守ります。
 *
 * - 2D の `G` / `F8` とは別の入切（`settings.snap3d`）
 * - **6 種だけ**（下の `SNAP3D_KINDS`）
 * - 候補が複数なら `Tab` で次へ
 *
 * ## 候補が爆発することへの備え
 *
 * 見本の間取りで面が 425 枚、頂点は延べ 1700 点ほどあります。**全部を
 * 候補に出すと選べません。** 次の 3 つで絞ります。
 *
 * 1. **画面で近いものだけ**（既定 12px）。世界の距離では測らない
 * 2. **同じ場所に重なった点はまとめる**。面は頂点を共有するので、
 *    壁 1 本の角が 6 回も出てくる
 * 3. **種別の優先順**。頂点が取れるなら辺の上は出さない
 */

/**
 * 吸着の種別。**6 つだけ。**
 *
 * AutoCAD の `3DOSMODE` も 6 つ（頂点・辺の中点・面の中心・節点・垂線・
 * 面の最寄り）に絞っています。ここは MiniCAD にあるものに置き換えました
 * ——「節点」と「垂線」は持っていないので、代わりに**辺の上**と
 * **格子**を置いています。**持っていないものを名前だけ並べない。**
 *
 * 並びがそのまま優先順です。上にあるものが取れたら、下は出しません。
 */
export const SNAP3D_KINDS = [
  "vertex",
  "midpoint",
  "faceCenter",
  "edge",
  "face",
  "grid",
] as const;

export type Snap3DKind = (typeof SNAP3D_KINDS)[number];

/** 画面に出す名前。`Record` なので種別を足して書き忘れると型検査が止まる */
export const SNAP3D_LABELS: Record<Snap3DKind, string> = {
  vertex: "頂点",
  midpoint: "辺の中点",
  faceCenter: "面の中心",
  edge: "辺の上",
  face: "面の上",
  grid: "格子",
};

export interface Snap3DHit {
  kind: Snap3DKind;
  at: Vec3;
  /** 画面上の距離 (px)。同じ種別の中では近い順 */
  dist: number;
}

/** 画面でこの距離に入ったものだけを候補にする (px) */
export const SNAP3D_RADIUS = 12;

/** 同じ場所とみなす距離 (mm)。面は頂点を共有するので、まとめないと同じ角が何度も出る */
const SAME_MM = 0.5;

/** 1 回の探索で見る面の上限。**大きな図面で詰まらせない** */
const MAX_FACES = 4000;

/**
 * いま指している画面の点に吸い付く候補を、**優先順に**返す。
 *
 * 返すのは「いちばん良いもの 1 つ」ではなく**一覧**です。AutoCAD と同じく
 * `Tab` で送れるようにするため——角が重なって見えるとき、手前のものしか
 * 選べないと目的の点に触れません。
 *
 * **同じ種別の中では画面で近い順**、種別が違えば `SNAP3D_KINDS` の順。
 */
export function snap3dCandidates(
  mesh: readonly Face3[],
  view: View,
  width: number,
  height: number,
  screen: Vec,
  radiusPx = SNAP3D_RADIUS,
): Snap3DHit[] {
  const found: Snap3DHit[] = [];
  /** 同じ場所を 2 度出さないための印。`種別|丸めた座標` */
  const seen = new Set<string>();
  /** すでに出した辺。**座標ではなく辺そのもの**で数える */
  const seenEdges = new Set<string>();

  const key = (kind: Snap3DKind, p: Vec3): string =>
    `${kind}|${Math.round(p.x / SAME_MM)}|${Math.round(p.y / SAME_MM)}|${Math.round(p.z / SAME_MM)}`;

  /** 候補に入れる。入れたら true */
  const put = (kind: Snap3DKind, p: Vec3): boolean => {
    const s = projectPoint(view, p, width, height);
    if (!s) return false;
    const dist = Math.hypot(s.x - screen.x, s.y - screen.y);
    if (dist > radiusPx) return false;
    const k = key(kind, p);
    if (seen.has(k)) return false;
    seen.add(k);
    found.push({ kind, at: p, dist });
    return true;
  };

  const faces = mesh.length > MAX_FACES ? mesh.slice(0, MAX_FACES) : mesh;
  for (const face of faces) {
    const pts = face.points;
    if (pts.length < 2) continue;

    // 頂点
    for (const p of pts) put("vertex", p);

    // 辺の中点と、辺の上のいちばん近い点
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      put("midpoint", mid3(a, b));
      /*
       * **辺は「辺そのもの」で数える。**
       *
       * 辺の上のいちばん近い点は少しずつ違う座標になるので、座標で
       * まとめても collapse しません。隣り合う面が同じ辺を共有すると、
       * **同じ 1 本の辺が何度も候補に並びます**（実測で 1 点に 15 個）。
       * 両端の組で印を付けて、1 本につき 1 つにします。
       */
      const edgeKey = edgeIdOf(a, b);
      if (!seenEdges.has(edgeKey)) {
        const near = nearestOnEdgeScreen(a, b, view, width, height, screen);
        if (near && put("edge", near)) seenEdges.add(edgeKey);
      }
    }

    // 面の中心（頂点の平均。凸でない面では中心が外に出ることもあるが、
    // 壁・床・立体の面はすべて凸なので起きない）
    if (pts.length >= 3) put("faceCenter", centroid3(pts));
  }

  found.sort((x, y) => {
    const d = SNAP3D_KINDS.indexOf(x.kind) - SNAP3D_KINDS.indexOf(y.kind);
    return d !== 0 ? d : x.dist - y.dist;
  });
  /*
   * **並べたあとで打ち切る。** `Tab` は 1 回 1 つ送るので、候補が多いと
   * 目的の点まで何度も押すことになります。優先順の上から数個あれば、
   * 実際に選びたいものは入っています。
   */
  return found.length > MAX_CANDIDATES ? found.slice(0, MAX_CANDIDATES) : found;
}

/** `Tab` で回せる数。多すぎると送りきれない */
const MAX_CANDIDATES = 8;

/** 辺の名前。両端を入れ替えても同じになるよう、小さいほうを先にする */
function edgeIdOf(a: Vec3, b: Vec3): string {
  const ka = `${Math.round(a.x / SAME_MM)},${Math.round(a.y / SAME_MM)},${Math.round(a.z / SAME_MM)}`;
  const kb = `${Math.round(b.x / SAME_MM)},${Math.round(b.y / SAME_MM)},${Math.round(b.z / SAME_MM)}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

const mid3 = (a: Vec3, b: Vec3): Vec3 => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
  z: (a.z + b.z) / 2,
});

const centroid3 = (pts: readonly Vec3[]): Vec3 => {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
    z += p.z;
  }
  return { x: x / pts.length, y: y / pts.length, z: z / pts.length };
};

/**
 * 辺の上で、カーソルにいちばん近い点。
 *
 * **画面の上で測る。** 世界の上で測ると、画面では遠い点が「近い」と
 * 判定されます（奥行きのぶん）。両端を投影して、画面上の線分に
 * カーソルを下ろした割合を、そのまま世界の線分に当てはめます
 * ——透視投影では厳密には等しくありませんが、12px の範囲では
 * 差が見えません（吸い付いたあとの点は世界の辺の上にきちんと乗ります）。
 */
function nearestOnEdgeScreen(
  a: Vec3,
  b: Vec3,
  view: View,
  width: number,
  height: number,
  screen: Vec,
): Vec3 | null {
  const sa = projectPoint(view, a, width, height);
  const sb = projectPoint(view, b, width, height);
  if (!sa || !sb) return null;
  const dx = sb.x - sa.x;
  const dy = sb.y - sa.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return null;
  let t = ((screen.x - sa.x) * dx + (screen.y - sa.y) * dy) / len2;
  // **端は出さない。** そこは「頂点」の仕事で、種別がぶつかる
  if (t < 0.02 || t > 0.98) return null;
  t = Math.min(1, Math.max(0, t));
  return add3(a, scale3(sub3(b, a), t));
}

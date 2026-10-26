import { pointInPolygon, vec, type Vec } from '../core/geometry.ts';
import type { EntityRef } from '../core/types.ts';
import { aspectOf, cameraBasis, type Camera3D } from './camera.ts';
import type { Face3 } from './mesh.ts';
import { add3, dot3, normalize3, scale3, sub3, vec3, type Vec3 } from './mat4.ts';

/**
 * 画面の点からワールドのレイを作る。3D で拾う／動かすの入口。
 *
 * **逆行列は足さない。** `mat4Invert` は 16 項の余因子展開で、呼ぶのはここ 1 箇所。
 * 符号を 1 つ間違えると**もっともらしく少しずれたレイ**が出て、既存のどのテストも
 * 捕まえない（「端のほうで拾えない」という形で後から効く）。軌道カメラは
 * 閉じた形なので、基底から解析的に組むほうが短く、確かめやすい。
 *
 * **`viewProjection` と同じ式を共有する。** `aspectOf` と `cameraBasis` を
 * 両方が使うので、片方だけ直してずれる余地が無い。ずれていないことは
 * 「投影して画面座標に直し、そこからレイを作ると元の点に戻る」で見ている。
 *
 * **受けるのは CSS ピクセル。** `paint` は座標に DPR を掛けるが、ポインタから
 * 来るのは `getBoundingClientRect()` 由来の CSS ピクセルなので、ここでは掛けない。
 */
export interface Ray3 {
  origin: Vec3;
  /** 単位ベクトル */
  direction: Vec3;
}

export function screenRay(cam: Camera3D, x: number, y: number, width: number, height: number): Ray3 {
  // paint の逆。x_px = (ndcX*0.5 + 0.5) * width、y_px = (0.5 - ndcY*0.5) * height
  const ndcX = width > 0 ? (x / width) * 2 - 1 : 0;
  const ndcY = height > 0 ? 1 - (y / height) * 2 : 0;

  const { eye, forward, right, up } = cameraBasis(cam);
  const aspect = aspectOf(width, height);
  const tanHalf = Math.tan(cam.fovY / 2);

  if (cam.mode === 'ortho') {
    // 平行投影は視線の向きが画面中で一定で、出る位置だけがずれる。
    // 半分の高さは viewProjection の mat4Ortho と同じ `distance * tan(fovY/2)`
    const halfH = cam.distance * tanHalf;
    const origin = add3(
      eye,
      add3(scale3(right, ndcX * halfH * aspect), scale3(up, ndcY * halfH)),
    );
    return { origin, direction: forward };
  }

  const dir = add3(
    forward,
    add3(scale3(right, ndcX * aspect * tanHalf), scale3(up, ndcY * tanHalf)),
  );
  return { origin: eye, direction: normalize3(dir, vec3(0, 0, -1)) };
}

/** レイ上の点 */
export const rayPointAt = (ray: Ray3, t: number): Vec3 => add3(ray.origin, scale3(ray.direction, t));

// --- 面との交差 -------------------------------------------------------------

/** レイが当たった面と、視点からの距離 */
export interface RayHit {
  /** 当たった面の出どころ。床は null */
  ref: EntityRef | null;
  /** 視点からの距離 (mm) */
  t: number;
  point: Vec3;
  face: Face3;
}

/** 平面と平行、とみなす閾値 */
const EPS = 1e-9;

/**
 * レイと面の交点までの距離。当たらなければ null。
 *
 * **三角形分割はしない。** 床は `room.innerPolygon` で、L 字やコの字になる。
 * 頂点 0 からの扇状分割は**凹多角形では単純に誤り**で、L 字の凹んだ側が
 * 当たってしまう。`pointInPolygon`（交差数）は任意の単純多角形で厳密に効く。
 * README の「三角形分割を書いていません」とも揃う。
 *
 * **背面は当たらない。** `normal · direction > 0` が背面で、これは `paint` の
 * `isBackFacing` と同じ判定（平行投影では完全に同じ式、透視では重心ではなく
 * 実際に当たった点で見ているぶん、むしろ正確）。
 * **見えている通りに拾える**ことが要るので、描く側と同じ規則を使う。
 */
export function rayFace(ray: Ray3, face: Face3, near: number): number | null {
  const denom = dot3(face.normal, ray.direction);
  if (!face.doubleSided && denom > -EPS) return null; // 背面、または平行
  if (Math.abs(denom) < EPS) return null; // 両面でも、平行なら当たらない

  const t = dot3(face.normal, sub3(face.points[0], ray.origin)) / denom;
  if (t <= near) return null; // 視点の後ろ、または near より手前

  const hit = rayPointAt(ray, t);
  // 法線の最も大きい成分の軸を落として 2D にする。
  // 落とすと巻き方向が反転しうるが、`pointInPolygon` は向きに依らない
  const n = face.normal;
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  const drop = az >= ax && az >= ay ? 2 : ay >= ax ? 1 : 0;
  const flat = (p: Vec3): Vec =>
    drop === 2 ? vec(p.x, p.y) : drop === 1 ? vec(p.x, p.z) : vec(p.y, p.z);

  return pointInPolygon(flat(hit), face.points.map(flat)) ? t : null;
}

/**
 * 当たった面を手前から順に。
 *
 * **手前かどうかは実際の距離で決める。`BUCKET_ORDER` は見ない。**
 * バケットの順は*描く*ための便法で、層をまたぐ深さを意図的に無視している。
 * 拾う側が本物の深さを使っても食い違わないのは、唯一食い違う構図
 * （床が壁を貫く）を `innerPolygon` が排除しているから。
 */
export function rayHits(ray: Ray3, mesh: Face3[], near: number): RayHit[] {
  const hits: RayHit[] = [];
  for (const face of mesh) {
    const t = rayFace(ray, face, near);
    if (t === null) continue;
    hits.push({ ref: face.ref, t, point: rayPointAt(ray, t), face });
  }
  return hits.sort((a, b) => a.t - b.t);
}

/**
 * いちばん手前の 1 枚。`accept` が false を返す面は読み飛ばして奥を見る。
 *
 * 画層をロックしたものはメッシュには載っている（`buildMesh` が落とすのは
 * 非表示だけ）ので、選べるかどうかの判断は呼ぶ側が `accept` で渡す。
 * ここにシーンの知識を持ち込まない。
 */
export function pickRay(
  ray: Ray3,
  mesh: Face3[],
  near: number,
  accept?: (ref: EntityRef | null) => boolean,
): RayHit | null {
  let best: RayHit | null = null;
  for (const face of mesh) {
    if (accept && !accept(face.ref)) continue;
    const t = rayFace(ray, face, near);
    if (t === null) continue;
    if (best && t >= best.t) continue;
    best = { ref: face.ref, t, point: rayPointAt(ray, t), face };
  }
  return best;
}

// --- ドラッグの面と軸 -------------------------------------------------------

export interface Plane3 {
  origin: Vec3;
  normal: Vec3;
}

/**
 * レイと平面の交点。**擦れ角では null を返す。**
 *
 * 視線が面と平行に近いと交点は ±∞ に飛ぶ。そのまま変位にすると、
 * カメラを水平に寝かせた瞬間に掴んだものが画面の外へ飛んでいく。
 * null を返して**直前の変位を保つ**のが正直な振る舞い。
 *
 * `minCos` は既定で 0.05（およそ 3 度）。
 */
export function rayPlane(ray: Ray3, plane: Plane3, minCos = 0.05): Vec3 | null {
  const denom = dot3(plane.normal, ray.direction);
  if (Math.abs(denom) < minCos) return null;
  const t = dot3(plane.normal, sub3(plane.origin, ray.origin)) / denom;
  if (!Number.isFinite(t)) return null;
  return rayPointAt(ray, t);
}

/**
 * `at` を通る鉛直線上の、カーソルが指している高さ。解が無ければ null。
 *
 * 壁の天端のように「上下にだけ動かす」操作で使う。
 *
 * **2 直線の最接近点では足りない。** それだと注視点から離れた軸で 1px ほど
 * ずれ、掴んだ天端がカーソルから少しずつ逃げる。代わりに
 * **軸を含んでカメラを向いた平面**を立て、そこにレイを落とす。平面が軸を
 * 含むので、落ちた点は必ず軸の上に乗り、投影し直すとカーソルにぴたりと戻る。
 *
 * 真上・真下から見下ろすと鉛直線は点に潰れ、平面が立たない。そのときは null。
 */
export function rayVerticalAt(ray: Ray3, at: Vec3, eye: Vec3): number | null {
  // 軸からカメラへ向かう水平成分が、平面の法線
  const nx = eye.x - at.x;
  const ny = eye.y - at.y;
  const len = Math.hypot(nx, ny);
  if (len < 1e-6) return null; // 真上から。鉛直線が点に潰れている
  const hit = rayPlane(ray, { origin: at, normal: vec3(nx / len, ny / len, 0) }, 1e-6);
  return hit ? hit.z : null;
}

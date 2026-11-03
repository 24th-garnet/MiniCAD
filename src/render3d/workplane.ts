import { add3, cross3, dot3, normalize3, scale3, sub3, vec3, type Vec3 } from './mat4.ts';
import { polygonFace, type Face3, type FaceSource } from './mesh.ts';
import type { Id } from '../core/types.ts';

/**
 * 作図面。**3D の中で「どこに置くか」を決める 1 枚の面。**
 *
 * 原点と法線のほかに、面の中の 2 軸（`u` / `v`）を持つ。2 軸が無いと
 * 「この面の上で 300mm 刻みに丸める」が書けない——丸めは面の中の座標でやるもので、
 * ワールドの x・y で丸めると、傾いた面の上では格子が斜めに潰れる。
 *
 * **面は人が選ばない。いま指している面がそのまま作図面になる。**
 * SketchUp と同じで、モードもボタンも要らない。何にも当たっていなければ
 * その階の床面を使う。`Plane3`（`ray.ts`）は原点と法線だけなので別の型にしてある。
 *
 * **ここは「置く場所」だけを決める。立体の向きは変えない。** `Fixture` は
 * z 軸まわりにしか回らないので、壁の面を指しても立体は立ったまま、
 * 指した点の高さに置かれる。傾けられるかのように見せるほうが嘘になる
 * （`docs/status.md` の確認事項 11）。
 */
export interface WorkPlane {
  origin: Vec3;
  normal: Vec3;
  /** 面の中の 2 軸。正規直交で、`u × v` が法線 */
  u: Vec3;
  v: Vec3;
  /** 画面に出す名前 */
  label: string;
}

/** 水平な作図面。既定はその階の床 */
export const floorPlane = (z: number, label = '床'): WorkPlane => ({
  origin: vec3(0, 0, z),
  normal: vec3(0, 0, 1),
  u: vec3(1, 0, 0),
  v: vec3(0, 1, 0),
  label,
});

/**
 * 面から作図面を作る。原点は指した点そのもの。
 *
 * 2 軸は法線から導く。**水平な面では u をワールドの x に合わせる**ので、
 * 床の上の格子が平面図の格子と同じ向きになる。
 */
export function planeFromNormal(normal: Vec3, at: Vec3, label: string): WorkPlane {
  const n = normalize3(normal);
  // **種を面へ落として 1 本目にする**（グラム・シュミット）。横を向いた面では
  // 真上が、上下を向いた面ではワールドの x が u になるので、**床の上の格子は
  // 平面図と同じ向き**、立った面の格子は縦横に揃う
  const seed = Math.abs(n.z) > 0.9 ? vec3(1, 0, 0) : vec3(0, 0, 1);
  const u = normalize3(sub3(seed, scale3(n, dot3(seed, n))), vec3(1, 0, 0));
  const v = cross3(n, u);
  return { origin: at, normal: n, u, v, label };
}

/** 面の中の座標 */
export interface PlaneUV {
  u: number;
  v: number;
}

export const toPlane = (plane: WorkPlane, p: Vec3): PlaneUV => {
  const d = sub3(p, plane.origin);
  return { u: dot3(d, plane.u), v: dot3(d, plane.v) };
};

export const fromPlane = (plane: WorkPlane, uv: PlaneUV): Vec3 =>
  add3(plane.origin, add3(scale3(plane.u, uv.u), scale3(plane.v, uv.v)));

/**
 * 面の中で格子に丸める。**3D のスナップはこれだけ。**
 *
 * 頂点や辺に吸い付かせるのは入れていない。候補がすぐ数百になり
 * （サンプル間取りで 260 面）、どれに吸ったのかを見せる仕組みまで要る。
 * 格子丸めと「面の上の点」で足りる範囲に留めて、**足りないことは画面に書く**。
 */
export function roundOnPlane(plane: WorkPlane, p: Vec3, grid: number): Vec3 {
  if (!(grid > 0)) return p;
  const uv = toPlane(plane, p);
  return fromPlane(plane, {
    u: Math.round(uv.u / grid) * grid,
    v: Math.round(uv.v / grid) * grid,
  });
}

/** 格子の線の太さ。桝目に対する比。細すぎると視点を引いたとき消える */
const LINE_RATIO = 0.03;

/**
 * 作図面から浮かせる量 (mm)。面とぴったり同じだと塗りの勝ち負けがちらつく。
 *
 * **層は `wall`。** `floor` にすると床より先に塗られてしまい、
 * **壁の上に敷いた格子が壁に隠れる**（実際にそうなって見つけた）。
 * 壁・家具と同じ順位なら、2mm 浮いているぶんだけ深さで勝って手前に出る。
 */
const LIFT = 2;

/**
 * 作図面の格子。**線ではなく細長い多角形で描く。**
 *
 * `paint` に頼めるのは多角形の fill と stroke だけで、線を引く口は無い。
 * 幅を桝目の 3% にした帯を敷けば、同じ契約のまま線に見える。
 * `half` 枚ぶんを中心から四方に出すので、面の数は `(2·half+1) × 2`。
 */
export function planeGridFaces(
  plane: WorkPlane,
  center: Vec3,
  step: number,
  half: number,
  color: string,
  levelId: Id,
): Face3[] {
  if (!(step > 0) || half < 1) return [];
  const src: FaceSource = { ref: null, levelId };
  // 中心も格子に乗せる。カーソルに追従して格子が震えない
  const c = toPlane(plane, roundOnPlane(plane, center, step));
  const lift = scale3(plane.normal, LIFT);
  const reach = step * half;
  const w = (step * LINE_RATIO) / 2;
  const out: Face3[] = [];

  /**
   * 帯 1 本。**面の中の (u, v) で反時計回りに組む。**
   * `u × v` が法線なので、(u, v) で反時計回りなら法線は作図面と同じ向きになる。
   * 向きが逆だと `paint` が背面として落とし、格子が丸ごと消える。
   */
  const band = (corners: PlaneUV[]): void => {
    out.push(polygonFace(
      corners.map((uv) => add3(fromPlane(plane, uv), lift)),
      color, 'wall', src,
    ));
  };

  for (let i = -half; i <= half; i++) {
    const o = i * step;
    // u = o の縦線（v 方向に伸びる）
    band([
      { u: c.u + o - w, v: c.v - reach },
      { u: c.u + o + w, v: c.v - reach },
      { u: c.u + o + w, v: c.v + reach },
      { u: c.u + o - w, v: c.v + reach },
    ]);
    // v = o の横線（u 方向に伸びる）
    band([
      { u: c.u - reach, v: c.v + o - w },
      { u: c.u + reach, v: c.v + o - w },
      { u: c.u + reach, v: c.v + o + w },
      { u: c.u - reach, v: c.v + o + w },
    ]);
  }
  return out;
}

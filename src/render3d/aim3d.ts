import { levelOf } from "../core/level.ts";
import type { Editor } from "../ui/editor.ts";
import {
  add3,
  cross3,
  normalize3,
  scale3,
  sub3,
  vec3,
  type Vec3,
} from "./mat4.ts";
import { polygonFace, type Face3, type FaceSource } from "./mesh.ts";
import { rayPlane } from "./ray.ts";
import {
  floorPlane,
  planeFromNormal,
  roundOnPlane,
  type WorkPlane,
} from "./workplane.ts";
import type { Pointer3D } from "./interact.ts";

/**
 * 3D の道具が共有する小物。**狙いの定め方と、狙いの見せ方。**
 *
 * `Place3D`（19 段）が最初の 1 つで、そこに書いてあった「いま指している面が
 * そのまま作図面になる」という作法を、あとから来る道具（計測・コメント・作図）
 * にもそのまま使ってもらうために切り出した。**同じ作法を 4 回書かない。**
 *
 * `Tool3D.overlay()` は `ctx` に直に描かず**面を返す**契約なので、
 * 点や線を見せるにも面を組む。`paint` の契約（多角形の fill と stroke だけ）が
 * そのまま守られる。
 */

/** いま指している作図面と、その上の点 */
export interface Aim3D {
  plane: WorkPlane;
  at: Vec3;
}

/**
 * いま指している面と、その上の（格子に丸めた）点。
 *
 * **面は人が選ばない。** 何にも当たっていなければその階の床を使う。
 */
export function aimOnPlane(editor: Editor, p: Pointer3D): Aim3D | null {
  const scene = editor.store.scene;
  const level = levelOf(scene, scene.activeLevelId);
  const plane = p.hit
    ? planeFromNormal(
        p.hit.face.normal,
        p.hit.point,
        planeLabelOf(p.hit.face.normal),
      )
    : floorPlane(level.floorZ);
  const at = p.hit
    ? p.hit.point
    : rayPlane(p.ray, { origin: plane.origin, normal: plane.normal });
  if (!at) return null;
  const settings = editor.store.settings;
  const grid = settings.snapGrid ? settings.gridSize : 0;
  return { plane, at: roundOnPlane(plane, at, grid) };
}

/**
 * 狙いが動いたか。**変わったときだけ知らせる**ために使う——
 * 毎回知らせると、カーソルを動かすたびに全パネルが描き直される。
 *
 * **法線まで見る。** 名前（「傾いた面」）だけだと、別の斜面へ移ったときに
 * 仮の姿が古いままになる。
 */
export const sameAim = (a: Aim3D | null, b: Aim3D): boolean =>
  a !== null &&
  a.plane.label === b.plane.label &&
  a.plane.normal.x === b.plane.normal.x &&
  a.plane.normal.y === b.plane.normal.y &&
  a.plane.normal.z === b.plane.normal.z &&
  a.at.x === b.at.x &&
  a.at.y === b.at.y &&
  a.at.z === b.at.z;

/** 作図面の名前。法線の向きだけで決まる */
export const planeLabelOf = (normal: Vec3): string => {
  if (normal.z > 0.9) return "上を向いた面";
  if (normal.z < -0.9) return "下を向いた面";
  return Math.abs(normal.z) < 0.1 ? "立った面" : "傾いた面";
};

/**
 * 2 点を結ぶ細い角柱。**線を見せるために使う。**
 *
 * どの向きから見ても太さが変わらないように、断面を正方形にした 4 枚で組む。
 * 板 1 枚だと真横から見たとき消える。
 */
export function segmentTube(
  a: Vec3,
  b: Vec3,
  radius: number,
  color: string,
  src: FaceSource,
): Face3[] {
  const d = normalize3(sub3(b, a), vec3(1, 0, 0));
  // 軸と平行でない種を 1 つ選んで、直交する 2 軸を作る
  const seed = Math.abs(d.z) > 0.9 ? vec3(1, 0, 0) : vec3(0, 0, 1);
  const u = scale3(normalize3(cross3(d, seed), vec3(0, 1, 0)), radius);
  const v = scale3(normalize3(cross3(d, u), vec3(0, 0, 1)), radius);

  const corners = [
    add3(u, v),
    add3(scale3(u, -1), v),
    add3(scale3(u, -1), scale3(v, -1)),
    add3(u, scale3(v, -1)),
  ];
  const out: Face3[] = [];
  for (let i = 0; i < 4; i++) {
    const p = corners[i];
    const q = corners[(i + 1) % 4];
    out.push(
      polygonFace(
        [add3(a, p), add3(b, p), add3(b, q), add3(a, q)],
        color,
        "wall",
        src,
      ),
    );
  }
  return out;
}

/** 点の印。作図面の上に置く小さな十字 */
export function pointMarker(
  aim: Aim3D,
  size: number,
  color: string,
  src: FaceSource,
): Face3[] {
  const n = scale3(aim.plane.normal, MARKER_LIFT);
  const c = add3(aim.at, n);
  const arm = (axis: Vec3, cross: Vec3): Face3 => {
    const a = scale3(axis, size);
    const b = scale3(cross, size * 0.12);
    return polygonFace(
      [
        add3(c, add3(scale3(a, -1), scale3(b, -1))),
        add3(c, add3(a, scale3(b, -1))),
        add3(c, add3(a, b)),
        add3(c, add3(scale3(a, -1), b)),
      ],
      color,
      "wall",
      src,
    );
  };
  return [arm(aim.plane.u, aim.plane.v), arm(aim.plane.v, aim.plane.u)];
}

/** 面と同じ高さに置くと z 競合で消えるので、法線の向きへ少し浮かせる (mm) */
const MARKER_LIFT = 2;

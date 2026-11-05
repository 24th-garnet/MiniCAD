import { vec3Like, type Vec3Like } from "./geometry.ts";
import {
  isBoxFixture,
  rotateToLocal,
  rotateToWorld,
  specOf,
} from "./fixture.ts";
import { levelOf, wallHeightOf } from "./level.ts";
import type { EntityRef, Scene } from "./types.ts";

/**
 * 押し引き（ワイヤー 5 枚目の「プッシュ/プル」）。
 *
 * **壁の天端を掴んで高さを変える操作の一般化。** あれは `wall.height` だけを
 * 書く小さな処理だったが、汎用ソリッドが入ると「立体の面を掴んで押し引きする」
 * ほうが自然な操作になる。**書くのはやはり数値 1〜2 個**で、
 * ノードも輪郭も動かさない。
 *
 * **掴めるのは 3 通りだけ。**
 *
 * | 掴んだ面 | 動くもの | 固定されるもの |
 * |---|---|---|
 * | 壁・立体の上面 | 高さ | 下端 |
 * | 立体の下面 | 下端と高さ | 上端 |
 * | **矩形の**立体の側面 | その向きの大きさと中心 | 反対側の面 |
 *
 * **側面は矩形の輪郭だけ。** 円・三角・L 形・押し出した形では、1 つの面を
 * 動かした結果が `{w, h}` で表せない（辺を 1 本だけずらした形になる）。
 * 黙って別の形に変えるより、断って理由を出す。
 */

/** 高さと大きさの下限 (mm)。インスペクタの `Math.max(1, v)` と揃える */
export const MIN_PUSH_SIZE = 1;

/** 3D の点の最小の形。置き場は `core/geometry.ts` に移した */
export type { Vec3Like };

export type PushWhat = "top" | "bottom" | "side";

export interface PushTarget {
  ref: EntityRef;
  what: PushWhat;
  /**
   * 面の外向き法線（ワールド、単位ベクトル）。押し引きはこの向きに測る。
   *
   * **倒した立体では水平にも鉛直にもならない。** 立体にとっての上面でも、
   * ワールドでは斜めを向く。ドラッグの測り方はこの向きに従う
   */
  normal: Vec3Like;
  /** 鉛直の押し引きか。上面・下面がこれにあたる */
  vertical: boolean;
  /** 側面のときだけ: ローカルのどちらの軸か */
  axis: "x" | "y" | null;
  /** 側面のときだけ: +1 なら +軸側の面 */
  sign: 1 | -1;
  /** 掴んだ時点の値。変位はここからの差で当てる */
  start: {
    base: number;
    height: number;
    w: number;
    h: number;
    x: number;
    y: number;
  };
  /** 画面に出す名前 */
  label: string;
}

/**
 * 法線が真上・真下とみなせるか。
 *
 * **立体の場合はローカルで測る。** 倒した箱の上面はワールドでは斜めを向き、
 * z 成分が 0.9 を割る。「立体にとっての上面か」を聞きたいので、
 * 法線をローカルへ戻してから見る。
 */
const UP = 0.9;

/**
 * 掴んだ面が押し引きできるか。できるなら必要な情報を返す。
 *
 * `normal` はワールドの面の法線。`ref` が指すものに合わせて解釈する。
 */
export function pushTargetOf(
  scene: Scene,
  ref: EntityRef,
  normal: Vec3Like,
): PushTarget | null {
  if (ref.type === "wall") {
    const wall = scene.walls[ref.id];
    if (!wall || normal.z < UP) return null; // 壁は天端だけ。側面を押すと厚みの話になる
    const level = levelOf(scene, wall.levelId);
    return {
      ref,
      what: "top",
      normal: vec3Like(0, 0, 1),
      vertical: true,
      axis: null,
      sign: 1,
      start: {
        base: 0,
        height: wallHeightOf(wall, level),
        w: 0,
        h: 0,
        x: 0,
        y: 0,
      },
      label: "壁の高さ",
    };
  }
  if (ref.type !== "fixture") return null;
  const f = scene.fixtures[ref.id];
  if (!f || !specOf(f).solid) return null;
  const level = levelOf(scene, f.levelId);
  const spec = specOf(f);
  const start = {
    base: f.base ?? spec.defaultBase(level),
    height: f.height ?? spec.defaultHeight(level),
    w: f.size.w,
    h: f.size.h,
    x: f.x,
    y: f.y,
  };

  // **立体にとっての上下左右で見る。** 倒すとワールドの法線が斜めを向く
  const local = rotateToLocal(f, normal);
  const world = vec3Like(normal.x, normal.y, normal.z);

  if (local.z > UP) {
    return {
      ref,
      what: "top",
      normal: world,
      vertical: true,
      axis: null,
      sign: 1,
      start,
      label: "高さ",
    };
  }
  if (local.z < -UP) {
    return {
      ref,
      what: "bottom",
      normal: world,
      vertical: true,
      axis: null,
      sign: -1,
      start,
      label: "下端",
    };
  }

  // 側面。**矩形の輪郭だけ**（それ以外は 1 面だけ動かした形が `{w, h}` で表せない）
  if (!isBoxFixture(f.kind) || f.outline) return null;
  const axis: "x" | "y" = Math.abs(local.x) >= Math.abs(local.y) ? "x" : "y";
  const sign: 1 | -1 = (axis === "x" ? local.x : local.y) >= 0 ? 1 : -1;
  return {
    ref,
    what: "side",
    normal: world,
    vertical: false,
    axis,
    sign,
    start,
    label: axis === "x" ? "幅" : "奥行",
  };
}

/**
 * 変位 `d`（面の外向き法線の向き、mm）を当てる。**掴んだ時点の値からの差**で
 * 計算するので、同じドラッグ中に何度呼んでも積み上がらない。
 */
export function applyPush(
  scene: Scene,
  target: PushTarget,
  d: number,
): boolean {
  const { start } = target;
  if (target.ref.type === "wall") {
    const wall = scene.walls[target.ref.id];
    if (!wall) return false;
    wall.height = Math.max(MIN_PUSH_SIZE, start.height + d);
    return true;
  }
  const f = scene.fixtures[target.ref.id];
  if (!f) return false;

  if (target.what === "top") {
    f.height = Math.max(MIN_PUSH_SIZE, start.height + d);
    return true;
  }
  if (target.what === "bottom") {
    // **上端を動かさない。** 下へ押せば下端が下がり、そのぶん背が伸びる
    const height = Math.max(MIN_PUSH_SIZE, start.height + d);
    // 原点（底面の中心）はローカルの z に沿って動く。倒していれば横にも動く
    const shift = rotateToWorld(f, vec3Like(0, 0, start.height - height));
    f.base = start.base + shift.z;
    f.height = height;
    if (shift.x !== 0 || shift.y !== 0) {
      f.x = start.x + shift.x;
      f.y = start.y + shift.y;
    }
    return true;
  }

  // 側面。反対側の面を固定したまま、押した側だけを動かす
  const size = Math.max(
    MIN_PUSH_SIZE,
    (target.axis === "x" ? start.w : start.h) + d,
  );
  const grew = size - (target.axis === "x" ? start.w : start.h);
  if (target.axis === "x") f.size.w = size;
  else f.size.h = size;
  // 原点は伸びたぶんの半分だけ、押した向きへ動く。
  // **倒していれば上下にも動く**ので、下端も書き足す
  const half = (grew / 2) * target.sign;
  const shift = rotateToWorld(
    f,
    target.axis === "x" ? vec3Like(half, 0, 0) : vec3Like(0, half, 0),
  );
  f.x = start.x + shift.x;
  f.y = start.y + shift.y;
  if (shift.z !== 0) f.base = start.base + shift.z;
  return true;
}

/**
 * 掴んだ面の外向き法線に沿った軸。ドラッグの測り方を決める。
 *
 * **面の法線そのもの。** 倒していなければ上面は真上、側面は水平になるので、
 * 以前の書き方（鉛直は ±z、側面は法線の水平成分）と同じ向きが出る。
 */
export const pushAxis = (target: PushTarget): Vec3Like => target.normal;

import { rotate, vec, type Vec } from './geometry.ts';
import { isBoxFixture, specOf } from './fixture.ts';
import { levelOf, wallHeightOf } from './level.ts';
import type { EntityRef, Scene } from './types.ts';

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

export type PushWhat = 'top' | 'bottom' | 'side';

export interface PushTarget {
  ref: EntityRef;
  what: PushWhat;
  /** 面の外向き法線（ワールド、水平か鉛直）。押し引きはこの向きに測る */
  normal: Vec;
  /** 鉛直の押し引きか。上面・下面がこれにあたる */
  vertical: boolean;
  /** 側面のときだけ: ローカルのどちらの軸か */
  axis: 'x' | 'y' | null;
  /** 側面のときだけ: +1 なら +軸側の面 */
  sign: 1 | -1;
  /** 掴んだ時点の値。変位はここからの差で当てる */
  start: { base: number; height: number; w: number; h: number; x: number; y: number };
  /** 画面に出す名前 */
  label: string;
}

/** 法線が真上・真下とみなせるか */
const UP = 0.9;

/**
 * 掴んだ面が押し引きできるか。できるなら必要な情報を返す。
 *
 * `normal` はワールドの面の法線。`ref` が指すものに合わせて解釈する。
 */
export function pushTargetOf(scene: Scene, ref: EntityRef, normal: Vec3Like): PushTarget | null {
  if (ref.type === 'wall') {
    const wall = scene.walls[ref.id];
    if (!wall || normal.z < UP) return null; // 壁は天端だけ。側面を押すと厚みの話になる
    const level = levelOf(scene, wall.levelId);
    return {
      ref, what: 'top', normal: vec(0, 0), vertical: true, axis: null, sign: 1,
      start: { base: 0, height: wallHeightOf(wall, level), w: 0, h: 0, x: 0, y: 0 },
      label: '壁の高さ',
    };
  }
  if (ref.type !== 'fixture') return null;
  const f = scene.fixtures[ref.id];
  if (!f || !specOf(f).solid) return null;
  const level = levelOf(scene, f.levelId);
  const spec = specOf(f);
  const start = {
    base: f.base ?? spec.defaultBase(level),
    height: f.height ?? spec.defaultHeight(level),
    w: f.size.w, h: f.size.h, x: f.x, y: f.y,
  };

  if (normal.z > UP) {
    return { ref, what: 'top', normal: vec(0, 0), vertical: true, axis: null, sign: 1, start, label: '高さ' };
  }
  if (normal.z < -UP) {
    return { ref, what: 'bottom', normal: vec(0, 0), vertical: true, axis: null, sign: -1, start, label: '下端' };
  }

  // 側面。**矩形の輪郭だけ**（それ以外は 1 面だけ動かした形が `{w, h}` で表せない）
  if (!isBoxFixture(f.kind) || f.outline) return null;
  // ワールドの法線をローカルへ戻して、どちらの軸の面かを見る
  const local = rotate(vec(normal.x, normal.y), -f.angle);
  const axis: 'x' | 'y' = Math.abs(local.x) >= Math.abs(local.y) ? 'x' : 'y';
  const sign: 1 | -1 = (axis === 'x' ? local.x : local.y) >= 0 ? 1 : -1;
  return {
    ref, what: 'side', normal: vec(normal.x, normal.y), vertical: false, axis, sign, start,
    label: axis === 'x' ? '幅' : '奥行',
  };
}

/** 3D の法線を受けるための最小の形。`render3d/` の `Vec3` に依存しないため */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * 変位 `d`（面の外向き法線の向き、mm）を当てる。**掴んだ時点の値からの差**で
 * 計算するので、同じドラッグ中に何度呼んでも積み上がらない。
 */
export function applyPush(scene: Scene, target: PushTarget, d: number): boolean {
  const { start } = target;
  if (target.ref.type === 'wall') {
    const wall = scene.walls[target.ref.id];
    if (!wall) return false;
    wall.height = Math.max(MIN_PUSH_SIZE, start.height + d);
    return true;
  }
  const f = scene.fixtures[target.ref.id];
  if (!f) return false;

  if (target.what === 'top') {
    f.height = Math.max(MIN_PUSH_SIZE, start.height + d);
    return true;
  }
  if (target.what === 'bottom') {
    // **上端を動かさない。** 下へ押せば下端が下がり、そのぶん背が伸びる
    const height = Math.max(MIN_PUSH_SIZE, start.height + d);
    f.base = start.base + start.height - height;
    f.height = height;
    return true;
  }

  // 側面。反対側の面を固定したまま、押した側だけを動かす
  const size = Math.max(MIN_PUSH_SIZE, (target.axis === 'x' ? start.w : start.h) + d);
  const grew = size - (target.axis === 'x' ? start.w : start.h);
  if (target.axis === 'x') f.size.w = size;
  else f.size.h = size;
  // 中心は伸びたぶんの半分だけ、押した向きへ動く
  const shift = rotate(
    target.axis === 'x' ? vec((grew / 2) * target.sign, 0) : vec(0, (grew / 2) * target.sign),
    f.angle,
  );
  f.x = start.x + shift.x;
  f.y = start.y + shift.y;
  return true;
}

/** 掴んだ面の外向き法線に沿った軸。ドラッグの測り方を決める */
export const pushAxis = (target: PushTarget): Vec3Like =>
  target.vertical
    ? { x: 0, y: 0, z: target.what === 'bottom' ? -1 : 1 }
    : { x: target.normal.x, y: target.normal.y, z: 0 };

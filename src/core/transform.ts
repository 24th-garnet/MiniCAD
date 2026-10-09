import { angleOf, norm, sub, vec, type Vec } from './geometry.ts';

/**
 * 2x3 のアフィン変換。並びは Canvas の setTransform と同じ。
 *
 *   | a  c  e |
 *   | b  d  f |
 *
 * 移動・回転・鏡像をこの1つの型で表すことで、各エンティティの変換が
 * 「座標を写して、向きを持つものは向きを直す」だけになる。
 */
export interface Transform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export const translation = (delta: Vec): Transform => ({ a: 1, b: 0, c: 0, d: 1, e: delta.x, f: delta.y });

export function rotation(center: Vec, angle: number): Transform {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: center.x - cos * center.x + sin * center.y,
    f: center.y - sin * center.x - cos * center.y,
  };
}

/** 2点を通る直線を軸にした鏡像 */
export function mirror(p: Vec, q: Vec): Transform {
  const u = norm(sub(q, p));
  // 軸が潰れているときは何もしない変換にしておく（呼び出し側で弾くのが本筋だが保険）
  if (u.x === 0 && u.y === 0) return IDENTITY;
  const a = u.x * u.x - u.y * u.y;
  const b = 2 * u.x * u.y;
  return {
    a,
    b,
    c: b,
    d: -a,
    e: p.x - a * p.x - b * p.y,
    f: p.y - b * p.x + a * p.y,
  };
}

export function compose(outer: Transform, inner: Transform): Transform {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

export const applyPoint = (t: Transform, p: Vec): Vec =>
  vec(t.a * p.x + t.c * p.y + t.e, t.b * p.x + t.d * p.y + t.f);

/** 平行移動成分を無視して方向ベクトルだけ変換する */
export const applyVector = (t: Transform, v: Vec): Vec => vec(t.a * v.x + t.c * v.y, t.b * v.x + t.d * v.y);

export const determinant = (t: Transform): number => t.a * t.d - t.b * t.c;

/** 行列式が負 ＝ 鏡像。向きが反転するので、建具の開き勝手や円弧の向きを直す必要がある */
export const isMirror = (t: Transform): boolean => determinant(t) < 0;

/** 一様スケール量。今は常に 1 だが、将来 Scale コマンドを足すときの入口 */
export const scaleOf = (t: Transform): number => Math.sqrt(Math.abs(determinant(t)));

/**
 * 角度 `angle` を向いたものが、変換後に何度を向くか。
 *
 * 回転でも鏡像でも正しいので、呼ぶ側が「鏡像のときだけ特別扱い」を書かずに済む。
 * 家具の angle・円弧の startAngle/endAngle・文字の angle がすべてこの1本で片付く。
 */
export function directionAngleAfter(t: Transform, angle: number): number {
  return angleOf(applyVector(t, vec(Math.cos(angle), Math.sin(angle))));
}

import { add, len, rotate, sub, toRad, vec, type Vec } from './geometry.ts';

/**
 * 作図中に打ち込む座標の書式。
 *
 * 約束は AutoCAD / JW_CAD / LibreCAD と同じで、
 * **角度の区切りは `<` のみ、`,` は常に直交座標、`@` が相対**。
 *
 * | 入力 | 意味 |
 * |---|---|
 * | `3000` | 相対極座標。角度はマウスの向き |
 * | `3000<45` | 相対極座標、45度 |
 * | `@3000<45` | 同上（極座標では `@` は冗長だが受ける） |
 * | `1000,2000` | 絶対座標 |
 * | `@1000,2000` | 相対直交座標 |
 */
export type CoordInput =
  | { kind: 'polar'; length: number; angleDeg: number | null }
  | { kind: 'absolute'; point: Vec }
  | { kind: 'relative'; delta: Vec };

const NUMBER = String.raw`-?\d*\.?\d+`;
const POLAR = new RegExp(`^(${NUMBER})<(${NUMBER})$`);
const CARTESIAN = new RegExp(`^(${NUMBER}),(${NUMBER})$`);
const PLAIN = new RegExp(`^(${NUMBER})$`);

/**
 * 全角を NFKC で畳んでから解析する。
 * 日本語入力のまま `１０００，２０００` と打たれるのは避けられないので、ここで吸収する。
 */
export function parseCoordInput(text: string): CoordInput | null {
  const normalized = text.normalize('NFKC').replace(/\s+/g, '');
  if (!normalized) return null;

  const relative = normalized.startsWith('@');
  const body = relative ? normalized.slice(1) : normalized;
  if (!body) return null;

  const polar = POLAR.exec(body);
  if (polar) {
    const length = Number(polar[1]);
    const angleDeg = Number(polar[2]);
    if (!Number.isFinite(length) || length === 0 || !Number.isFinite(angleDeg)) return null;
    return { kind: 'polar', length, angleDeg };
  }

  const cartesian = CARTESIAN.exec(body);
  if (cartesian) {
    const x = Number(cartesian[1]);
    const y = Number(cartesian[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return relative ? { kind: 'relative', delta: vec(x, y) } : { kind: 'absolute', point: vec(x, y) };
  }

  const plain = PLAIN.exec(body);
  if (plain) {
    const length = Number(plain[1]);
    if (!Number.isFinite(length) || length === 0) return null;
    return { kind: 'polar', length, angleDeg: null };
  }

  return null;
}

const polarVector = (length: number, angleDeg: number): Vec => rotate(vec(length, 0), toRad(angleDeg));

/**
 * 点を求める文脈（作図の次の点）。
 * 相対・極座標は基準点が要る。極座標で角度が省略されたときだけ fallback を使う。
 */
export function resolvePoint(
  input: CoordInput,
  base: Vec | null,
  fallbackAngleDeg: number | null,
): Vec | null {
  switch (input.kind) {
    case 'absolute':
      return input.point;
    case 'relative':
      return base ? add(base, input.delta) : null;
    case 'polar': {
      if (!base) return null;
      const angle = input.angleDeg ?? fallbackAngleDeg;
      return angle === null ? null : add(base, polarVector(input.length, angle));
    }
  }
}

/**
 * 変位を求める文脈（移動・複写の距離）。
 * 絶対座標は「基準点からその点まで」と解釈する（AutoCAD と同じ）。
 */
export function resolveDelta(
  input: CoordInput,
  base: Vec | null,
  fallbackAngleDeg: number | null,
): Vec | null {
  switch (input.kind) {
    case 'absolute':
      return base ? sub(input.point, base) : null;
    case 'relative':
      return input.delta;
    case 'polar': {
      const angle = input.angleDeg ?? fallbackAngleDeg;
      return angle === null ? null : polarVector(input.length, angle);
    }
  }
}

/** 長さだけが欲しい文脈（オフセット距離・半径・回転角）。直交なら成分からの長さ */
export function resolveLength(input: CoordInput): number | null {
  switch (input.kind) {
    case 'polar':
      return input.length;
    case 'absolute':
      return len(input.point);
    case 'relative':
      return len(input.delta);
  }
}

export type CoordMode = 'point' | 'delta' | 'length' | 'angle';

/** 入力欄の案内文を1か所に集める */
export function placeholderFor(mode: CoordMode): string {
  switch (mode) {
    case 'point':
      return '例: 3000 / 3000<90 / 1000,2000 / @1000,2000';
    case 'delta':
      return '例: 3000<90 / @1000,2000';
    case 'length':
      return '長さ  例: 3000';
    case 'angle':
      return '角度  例: 90 / -45';
  }
}

export function hintFor(mode: CoordMode): string {
  switch (mode) {
    case 'point':
      return '長さ / 長さ<角度 / 絶対座標 X,Y / 相対 @X,Y';
    case 'delta':
      return '長さ<角度 または 相対 @X,Y';
    case 'length':
      return '長さ[mm]';
    case 'angle':
      return '角度[°]（反時計回りが正）';
  }
}

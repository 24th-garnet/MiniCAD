import { boundsOf, offsetPolyline, signedArea, type Vec } from './geometry.ts';

/**
 * 立体の上下の稜線の仕上げ——テーパ・面取り・丸め（ワイヤー 5 枚目）。
 *
 * **稜線ではなく「高さ方向の輪郭」で表す。** 本来の 3D 面取りは
 * 「どの稜線を落とすか」を選ぶもので、どの面とどの面が隣り合うかを知っている
 * 構造（B-rep）が要る。MiniCAD の立体は**平面の輪郭を押し出したもの**なので、
 * 隣り合わせの情報を持っていない。
 *
 * **押し出す途中の輪郭を何段かに分ける**ことにした。各段は
 * 「その高さ」と「内側へどれだけ縮めるか」の 2 つで決まる。
 *
 * | | 段 |
 * |---|---|
 * | テーパ | 下はそのまま、上を縮める（2 段） |
 * | 面取り | 上下の端だけ縮める（4 段） |
 * | 丸め | 上下の端を四分円に沿って縮める（段を刻む） |
 *
 * **上下の稜線にしか効かない。** 縦の稜線（角柱の角）を落とすには、
 * やはり隣り合わせの情報が要る。**できないことは画面に書く。**
 */

export const EDGE_KINDS = ['taper', 'chamfer', 'fillet'] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

export const EDGE_LABELS: Record<EdgeKind, string> = {
  taper: 'テーパ',
  chamfer: '面取り',
  fillet: '角の丸め',
};

export interface FixtureEdge {
  kind: EdgeKind;
  /** 縮める量 (mm)。丸めでは半径 */
  size: number;
}

export const isEdgeKind = (v: unknown): v is EdgeKind =>
  typeof v === 'string' && (EDGE_KINDS as readonly string[]).includes(v);

/** 押し出す途中の 1 段 */
export interface EdgeRing {
  /** 下端からの高さ (mm) */
  dz: number;
  /** 内側へ縮める量 (mm) */
  inset: number;
}

/** 丸めを何段に刻むか。四分円ぶん */
const FILLET_STEPS = 4;

/**
 * 段の並び。**下から上へ、高さが単調に増える。**
 *
 * `size` は高さの半分と、輪郭が潰れない範囲に収める。
 * 収めないと上下が交差した立体になり、体積が負になる。
 */
export function edgeRings(edge: FixtureEdge, height: number, maxInset: number): EdgeRing[] {
  const d = Math.max(0, Math.min(edge.size, maxInset, edge.kind === 'taper' ? height : height / 2));
  if (d <= 0) return [{ dz: 0, inset: 0 }, { dz: height, inset: 0 }];

  if (edge.kind === 'taper') {
    return [{ dz: 0, inset: 0 }, { dz: height, inset: d }];
  }
  if (edge.kind === 'chamfer') {
    return [
      { dz: 0, inset: d },
      { dz: d, inset: 0 },
      { dz: height - d, inset: 0 },
      { dz: height, inset: d },
    ];
  }
  // 丸め。下の四分円 → 真ん中 → 上の四分円
  const quarter = (from: number, up: boolean): EdgeRing[] =>
    Array.from({ length: FILLET_STEPS + 1 }, (_, i) => {
      const a = (Math.PI / 2) * (i / FILLET_STEPS);
      return up
        ? { dz: from + d * (1 - Math.cos(a)), inset: d * (1 - Math.sin(a)) }
        : { dz: from + d * Math.sin(a), inset: d * (1 - Math.cos(a)) };
    });
  return [...quarter(0, true), ...quarter(height - d, false)];
}

/**
 * 輪郭を内側へ縮める。**縮めきって潰れたら null。**
 *
 * `offsetPolyline` は自己交差を除かないので、縮めすぎると裏返った形が返る。
 * 向きが変わったか（符号付き面積）で見て、変わっていたら諦める。
 */
export function insetOutline(points: readonly Vec[], inset: number): Vec[] | null {
  if (inset <= 1e-9) return [...points];
  // **行きすぎは先に断る。** マイターのオフセットは縮めすぎても
  // 向きを保ったまま小さい形を返す（1000 角を 600 縮めると 200 角が返る）ので、
  // 出てきた形だけを見ても潰れたと分からない
  if (inset > maxInsetOf(points)) return null;
  const area = signedArea([...points]);
  // **反時計回りなら正のオフセットが内側。** 逆に書くと外へ膨らむ
  const got = offsetPolyline([...points], area > 0 ? inset : -inset, true);
  if (!got || got.length < 3) return null;
  if (!got.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
  const inner = signedArea(got);
  // 向きが変わった、または小さくなっていない＝縮められていない
  if (inner * area <= 0 || Math.abs(inner) >= Math.abs(area)) return null;
  return got;
}

/**
 * 縮められる上限のめやす。外接矩形の短いほうの半分。
 *
 * 正確な上限（内側のスケルトン）は要らない。**潰れたら `insetOutline` が
 * null を返す**ので、ここは「明らかに行きすぎ」を止めるだけ。
 */
export function maxInsetOf(points: readonly Vec[]): number {
  const b = boundsOf([...points]);
  if (!b) return 0;
  return Math.max(0, Math.min(b.max.x - b.min.x, b.max.y - b.min.y) / 2 - 1);
}

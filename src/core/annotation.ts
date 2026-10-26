import type { Attrs } from './attrs.ts';
import { dist, vec, type Vec } from './geometry.ts';
import type { Id } from './id.ts';
import type { LayerId } from './layer.ts';
import type { EntityRef } from './types.ts';

/**
 * 注釈。**距離計測とコメントのアンカー。**
 *
 * どちらも「図面の上の点を指して、人が何か書いたもの」で、
 * 図面そのものではない。だから寸法（`Shape` の `dimension`）とは別にする——
 * 寸法は図面に載る製図の記号で、JIS の矢と寸法線を持ち、DXF にも出る。
 * 計測とコメントは**打ち合わせの道具**で、紙には出ない。
 *
 * ## 計測はなぜ実体なのか
 *
 * これまで `MeasureTool` は `commit` を一度も呼ばず、ツールを離れた瞬間に
 * 消えていた。ワイヤーは座標・メモ付きの保存を求めている（「距離計測」の
 * フォームに座標始点/終点・自動/手動・メモが並ぶ）。
 *
 * ## コメントの本文はここに無い
 *
 * MiniCAD が持つのは**アンカーだけ** —— どの座標に、どの実体に紐づいているか。
 * 本文・作成者・日時・リプライ・メンション・解決状態・メール通知は**すべてホスト**。
 * `badge` はホストが描きたいものを不透明に運ぶ袋で、MiniCAD は中身を読まない。
 */

/** 点。**z を持つ。** ワイヤーのフォームが xyz を並べている */
export interface Point3 {
  x: number;
  y: number;
  /** 階の床からの高さ (mm) */
  z: number;
}

export interface Measurement {
  id: Id;
  a: Point3;
  b: Point3;
  /**
   * 手で入れた距離 (mm)。null なら 2 点から自動で出す。
   *
   * **自動と手動を畳まない。** 畳むと「測ったら 1234 だった」と
   * 「1234 だと聞いた」が同じ数字になり、どちらか分からなくなる。
   * `Wall.height` の既定落ちと同じ考え方。
   */
  manual: number | null;
  note: string;
  layerId: LayerId;
  levelId: Id;
  attrs: Attrs;
}

/** 2 点から出る距離 (mm)。z も見る */
export const measuredDistance = (m: Measurement): number =>
  Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y, m.b.z - m.a.z);

/** 画面に出す距離。手入力があればそれ */
export const distanceOf = (m: Measurement): number => m.manual ?? measuredDistance(m);

/** 平面に落とした長さ。平面図の上での見かけの長さ */
export const planLength = (m: Measurement): number => dist(vec(m.a.x, m.a.y), vec(m.b.x, m.b.y));

/** 平面での中点。ラベルを置く位置 */
export const planMid = (m: Measurement): Vec =>
  vec((m.a.x + m.b.x) / 2, (m.a.y + m.b.y) / 2);

/**
 * コメントのアンカー。**本文はホストが持つ。**
 */
export interface CommentAnchor {
  id: Id;
  at: Point3;
  /** 紐づく実体。無ければ空間の点 */
  ref: EntityRef | null;
  levelId: Id;
  /**
   * ホストが描きたいものを不透明に運ぶ。MiniCAD は中身を読まない。
   *
   * 画面にはバッジの番号だけを出す。何件のリプライがあるか、解決済みか、
   * 誰が書いたかはホストの話で、ここに型を足すとホストの語彙が
   * 図面の形式に漏れる。
   */
  badge: unknown;
}

export const point3 = (x: number, y: number, z = 0): Point3 => ({ x, y, z });

/** 読み込みで点を整える。壊れていれば null */
export function readPoint3(raw: unknown): Point3 | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.x !== 'number' || typeof p.y !== 'number') return null;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  const z = typeof p.z === 'number' && Number.isFinite(p.z) ? p.z : 0;
  return { x: p.x, y: p.y, z };
}

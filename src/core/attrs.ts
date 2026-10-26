import type { Id } from './id.ts';

/**
 * 実体に共通して乗る属性。
 *
 * **袋（`Record<string, unknown>`）にはしない。** それを入れると、種別を足したときに
 * 埋め忘れが型エラーになるというこの codebase の性質がそこだけ消える。
 * 欄は閉じた集合として持ち、増やすときは型を足す。
 *
 * 欄の出どころは作図画面の「オブジェクト編集」で、そこに並ぶのは
 * **グループ・色・素材・積算・レイヤー・シンボル**の 6 つ。レイヤーは既に
 * 実体が持っているので、残りの 5 つがここに来る。
 *
 * **MiniCAD は `materialRef` と `symbolId` の中身を解釈しない。** どちらも
 * ホスト（またはシンボルの表）の識別子をそのまま運ぶだけ。意味を持たせると、
 * 分類が増えるたびに図面の形式が変わる。
 */
export interface Attrs {
  /** 同じ値を持つものが 1 グループ。null はどのグループにも属さない */
  groupId: Id | null;
  /** 色の上書き。null なら画層の色に従う */
  color: string | null;
  /** 素材。ホストの識別子を不透明に運ぶ */
  materialRef: string | null;
  /** 積算の対象か。**null は「まだ決めていない」** */
  takeoff: TakeoffMode | null;
  /** 由来のシンボル。null ならどのシンボルにも属さない */
  symbolId: Id | null;
}

/**
 * 積算の対象かどうか。
 *
 * **3 つの状態を分ける。** `'included'`（拾う）、`'excluded'`（人が拾わないと決めた）、
 * `null`（まだ決めていない）。畳むと**書き忘れが「拾わないと決めた」に化ける**。
 * 画層の表示・非表示や `Wall.height` の既定落ちと同じ考え方。
 */
export type TakeoffMode = 'included' | 'excluded';

const TAKEOFF_MODES: ReadonlySet<string> = new Set<string>(['included', 'excluded']);

export const isTakeoffMode = (v: unknown): v is TakeoffMode =>
  typeof v === 'string' && TAKEOFF_MODES.has(v);

/** 何も指定されていない状態。**全部 null**で、既定は読む側が決める */
export const defaultAttrs = (): Attrs => ({
  groupId: null,
  color: null,
  materialRef: null,
  takeoff: null,
  symbolId: null,
});

/** 1 つでも指定されているか。インスペクタの見出しを出すかの判断に使う */
export const hasAttrs = (a: Attrs): boolean =>
  a.groupId !== null ||
  a.color !== null ||
  a.materialRef !== null ||
  a.takeoff !== null ||
  a.symbolId !== null;

import type { Wall } from './types.ts';

/**
 * 階の縦方向の設定。
 *
 * `DrawingStandard`（線群・尺度・文字高・用紙）は**紙の属性**で、尺度を変えれば
 * 見え方が変わるもの。階高は**建物の属性**で、尺度とは無関係に決まる。
 * `Sheet` が `DrawingStandard` と分かれているのと同じ理由で、ここも独立させる。
 */
export interface Level {
  /** 床の高さ (mm)。多階層にするときの足がかりで、当面は 0 */
  floorZ: number;
  /** 壁の既定の高さ (mm)。個々の壁が上書きできる */
  wallHeight: number;
}

export const defaultLevel = (): Level => ({ floorZ: 0, wallHeight: 2400 });

export const wallHeightOf = (wall: Wall, level: Level): number =>
  positiveOr(wall.height, level.wallHeight);

/** 上書きが有効な数値ならそれを、そうでなければ既定を返す */
export const positiveOr = (value: number | null | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

/** 0 以上なら上書きを採る（窓台の高さは 0 が正当なので別扱い） */
export const nonNegativeOr = (value: number | null | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

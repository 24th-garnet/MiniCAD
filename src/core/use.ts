/**
 * 物件用途。ワイヤーの改訂版（8 枚目）が各パーツに付けている
 * ＜住・オ・店＞ のタグで、画面上部のラジオでパレットを絞る。
 *
 * **ホストのカタログの絞り込みとは別物。** あちらはホストが済ませて
 * 渡してくるもので、こちらは MiniCAD が持っている建築パーツを
 * 使う人がその場で絞るための札。
 */
export const USES = ['住', 'オ', '店'] as const;

export type Use = (typeof USES)[number];

/** ラジオに出す名前。タグ 1 文字では何のことか分からない */
export const USE_LABELS: Record<Use, string> = {
  住: '住宅',
  オ: 'オフィス',
  店: '店舗',
};

/** どの用途でもよく使うもの。1 文字ずつ書き並べずに済ませる */
export const ALL_USES: readonly Use[] = USES;

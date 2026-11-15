import type { ToolId } from '../tools/tool.ts';

/**
 * 画面のアイコン。**全部ここで線を引いて作る。**
 *
 * 以前は Unicode の記号 1 字だった（`↖ ⫽ ✂ ⇥ ⨉ ◝ ◆ ⠿`）。字形が環境ごとに
 * 変わり、線の太さも大きさも揃わず、`⠿` のように意味の読めないものもあった。
 *
 * **既製のアイコンセットは引き写さない。** オフセット・トリム・延長・
 * 角の丸め・配列複写といった CAD 固有の記号はどのセットにも無く、
 * 混ぜると線の太さと余白が揃わない。どれも直線と円弧だけで描けるので自前で足りる。
 *
 * 決めごと:
 * - 升目は 24×24。線は 1.5px、角と端は丸。塗りは使わない
 * - 色は `currentColor`。押している最中の色はボタン側の `color` で決まる
 * - 1 つのアイコンは `d` の配列。円は円弧 2 つ、点は `h.01`（丸い端が点になる）
 */
export type IconName =
  | ToolId
  // 右レールの束（`section-registry.ts` の `PANE_SPECS`）
  | 'properties'
  | 'parts'
  | 'layers'
  | 'sheet'
  | 'info'
  // 図面の上に浮かぶもの
  | 'eye'
  | 'plus'
  | 'minus'
  | 'chevronLeft'
  | 'chevronRight';

/**
 * アイコン 1 つぶんの線。
 *
 * **`Record` にしてある**ので、`IconName` を広げて線を書き忘れると
 * コンパイルエラーになる。`TOOL_REGISTRY` と同じ作法
 */
export const ICONS: Record<IconName, readonly string[]> = {
  // --- 選ぶ・測る ---
  select: ['M5 3v15l3.6-3.6 2.4 5 2.2-1-2.4-4.9H16.5z'],
  measure: ['M3 15 15 3l6 6L9 21z', 'M7.5 10.5l2 2', 'M10.5 7.5l2 2', 'M13.5 4.5l2 2'],

  // --- 変形 ---
  copy: ['M9 9h11v11H9z', 'M4 15V4h11'],
  rotate: ['M20 12a8 8 0 1 1-2.3-5.7', 'M20 4v4h-4'],
  mirror: ['M12 3v18', 'M9 7 4 12l5 5z', 'M15 7l5 5-5 5z'],
  array: ['M4 4h4v4H4z', 'M10 4h4v4h-4z', 'M16 4h4v4h-4z', 'M4 10h4v4H4z', 'M4 16h4v4H4z'],

  // --- 編集。**どれも既製のセットには無い** ---
  // 元の輪郭と、そこから等距離の輪郭
  offset: ['M6 6h12v12H6z', 'M3 3h18v18H3z'],
  // 切断する辺（縦）で線が切れている
  trim: ['M3 12h7', 'M14 12h7', 'M12 4v16'],
  // 境界（右の縦線）まで線を伸ばす
  extend: ['M3 12h10', 'M13 12h5', 'M15.5 9.5 18 12l-2.5 2.5', 'M21 5v14'],
  // 線の上に刃が降りてくる
  split: ['M3 17h18', 'M10 3v10', 'M7 10l3 3 3-3'],
  // 角の丸め。尖った角（細い線）と、丸めたあとの輪郭
  corner: ['M4 20V10a6 6 0 0 1 6-6h10', 'M4 10h6V4'],
  // 折れ線の頂点をつかむ
  vertex: ['M3 18 9 9l5 4 7-9', 'M7.5 7.5h3v3h-3z'],
  // 色を吸い上げる
  eyedrop: [
    'M19 5a2.5 2.5 0 0 0-3.5 0L14 6.5 17.5 10 19 8.5a2.5 2.5 0 0 0 0-3.5z',
    'M13.5 7 5 15.5V19h3.5L17 10.5',
  ],

  // --- 間取り ---
  // 平面の壁は太い帯
  wall: ['M3 9h18v6H3z'],
  // 柱と梁
  fixture: ['M5 3h5v18H5z', 'M14 7h6v4h-6z'],
  // 立体
  solid: ['M12 3 21 8v8l-9 5-9-5V8z', 'M12 12 21 8', 'M12 12v9', 'M12 12 3 8'],
  // JIS の建具記号そのもの。扉と開き勝手の円弧
  door: ['M5 19V7', 'M5 7a12 12 0 0 1 12 12', 'M3 19h2', 'M17 19h4'],
  // 壁の帯の中に建具の線
  window: ['M3 9h18v6H3z', 'M3 12h18', 'M12 9v6'],
  block: ['M4 5h16v14H4z', 'M12 8l4 4-4 4-4-4z'],
  assembly: ['M3 4h18v16H3z', 'M6 9h5v6H6z', 'M13 11h5v6h-5z'],
  room: ['M4 5h16v14H4z', 'M8 10h8', 'M8 14h5'],

  // --- 汎用図形 ---
  line: ['M4 20 20 4'],
  // 作図（矩形・曲線）
  shape: ['M4 5h16v14H4z'],
  arc: ['M3 18A15 15 0 0 1 18 3', 'M3 18h.01', 'M18 3h.01'],
  point: ['M12 4v6', 'M12 14v6', 'M4 12h6', 'M14 12h6', 'M12 12h.01'],
  text: ['M5 20 12 4l7 16', 'M8 14h8'],
  dimension: ['M4 8v8', 'M20 8v8', 'M4 12h16', 'M7 9l-3 3 3 3', 'M17 9l3 3-3 3'],
  comment: ['M4 5h16v11H9l-5 4z'],

  // --- 右レールの束 ---
  properties: ['M3 7h18', 'M3 12h18', 'M3 17h18', 'M9 5v4', 'M15 10v4', 'M7 15v4'],
  parts: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  layers: ['M12 3 3 8l9 5 9-5z', 'M3 13l9 5 9-5'],
  sheet: ['M4 3h16v18H4z', 'M4 16h16', 'M13 16v5'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18', 'M12 11v6', 'M12 7.5h.01'],

  // --- 図面の上に浮かぶもの ---
  eye: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  chevronLeft: ['M15 5l-7 7 7 7'],
  chevronRight: ['M9 5l7 7-7 7'],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * アイコンを 1 つ作る。
 *
 * **`el()` は使えない。** `el` は `document.createElement` なので、
 * SVG の名前空間に入らず、作っても描かれない。ここだけ `createElementNS`。
 *
 * `aria-hidden` を立てるのは、どのボタンも**文字の名札を一緒に出している**ため。
 * 読み上げでアイコンの名前まで読まれると二度言いになる。
 */
export function icon(name: IconName, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

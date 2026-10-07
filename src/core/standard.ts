/**
 * 製図規格のプリセット。
 *
 * ここの数値は「紙の上での mm」です。ワールド座標の mm とは別物なので、
 * 図面に落とすときは尺度の分母を掛けて世界座標に直します（1:100 なら 0.5mm → 50mm）。
 *
 * JIS は任意規格なので、ここで用意するのはあくまで選べるプリセットであり、
 * 準拠を強制はしません（市販CADも同じ作りです）。
 */

/** JIS Z 8312 が定める線の太さ (mm)。この9種から選ぶ */
export const JIS_LINE_WIDTHS = [0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1.0, 1.4, 2.0] as const;

export type WeightRole = 'thin' | 'thick' | 'extraThick';

/** 細線:太線:極太線 = 1:2:4 の組。JIS Z 8312 でいう線群 */
export interface LineGroup {
  id: string;
  label: string;
  thin: number;
  thick: number;
  extraThick: number;
}

export const LINE_GROUPS: LineGroup[] = [
  { id: '0.5', label: '線群 0.5 (0.13 / 0.25 / 0.5)', thin: 0.13, thick: 0.25, extraThick: 0.5 },
  { id: '0.7', label: '線群 0.7 (0.18 / 0.35 / 0.7)', thin: 0.18, thick: 0.35, extraThick: 0.7 },
  { id: '1.0', label: '線群 1.0 (0.25 / 0.5 / 1.0)', thin: 0.25, thick: 0.5, extraThick: 1.0 },
  { id: '1.4', label: '線群 1.4 (0.35 / 0.7 / 1.4)', thin: 0.35, thick: 0.7, extraThick: 1.4 },
  { id: '2.0', label: '線群 2.0 (0.5 / 1.0 / 2.0)', thin: 0.5, thick: 1.0, extraThick: 2.0 },
];

export const lineGroupById = (id: string): LineGroup => LINE_GROUPS.find((g) => g.id === id) ?? LINE_GROUPS[2];

export function weightOf(group: LineGroup, role: WeightRole): number {
  return role === 'thin' ? group.thin : role === 'thick' ? group.thick : group.extraThick;
}

/** JIS Z 8313 の文字高さ系列 (mm)。公比 √2 */
export const JIS_TEXT_HEIGHTS = [1.8, 2.5, 3.5, 5, 7, 10, 14, 20] as const;

/**
 * JIS Z 8314 の推奨尺度（1:2, 1:5, 1:10 とその10のべき倍）のうち、
 * 建築の平面図で実際に使うもの。値は縮尺の分母。
 */
export const PLAN_SCALES = [20, 50, 100, 200, 500] as const;

export interface PaperSize {
  id: string;
  label: string;
  /** 長辺・短辺 (mm) */
  long: number;
  short: number;
}

/** JIS Z 8311 の A 列 */
export const PAPER_SIZES: PaperSize[] = [
  { id: 'A0', label: 'A0 (1189×841)', long: 1189, short: 841 },
  { id: 'A1', label: 'A1 (841×594)', long: 841, short: 594 },
  { id: 'A2', label: 'A2 (594×420)', long: 594, short: 420 },
  { id: 'A3', label: 'A3 (420×297)', long: 420, short: 297 },
  { id: 'A4', label: 'A4 (297×210)', long: 297, short: 210 },
];

export const paperById = (id: string): PaperSize => PAPER_SIZES.find((p) => p.id === id) ?? PAPER_SIZES[3];

export type LineType = 'continuous' | 'dashed' | 'hidden' | 'center' | 'phantom';

/** 線種のダッシュパターン。長さは紙の上の mm */
export const LINE_TYPE_PATTERNS: Record<LineType, number[]> = {
  continuous: [],
  dashed: [4, 2],
  hidden: [2, 1],
  center: [12, 2, 2, 2],
  phantom: [12, 2, 2, 2, 2, 2],
};

export const LINE_TYPE_LABELS: Record<LineType, string> = {
  continuous: '実線',
  dashed: '破線',
  hidden: 'かくれ線',
  center: '一点鎖線',
  phantom: '二点鎖線',
};

/** シーンと一緒に保存される製図規格の設定 */
export interface DrawingStandard {
  /** プリセット名。参考情報で、実際の描画は下のフィールドが決める */
  preset: string;
  lineGroupId: string;
  /** 尺度の分母。100 なら 1:100 */
  scale: number;
  /** 文字高さ (紙の上の mm) */
  textHeight: {
    room: number;
    area: number;
    dimension: number;
    furniture: number;
  };
  paperId: string;
  orientation: 'landscape' | 'portrait';
  /** 壁を塗りつぶすか、輪郭線だけで描くか */
  wallFill: boolean;
}

export function jisStandard(): DrawingStandard {
  return {
    preset: 'JIS A3 1:100',
    lineGroupId: '1.0',
    scale: 100,
    textHeight: { room: 5, area: 3.5, dimension: 2.5, furniture: 2.5 },
    paperId: 'A3',
    orientation: 'landscape',
    wallFill: true,
  };
}

export interface StandardPreset {
  id: string;
  label: string;
  make(): DrawingStandard;
}

export const STANDARD_PRESETS: StandardPreset[] = [
  {
    id: 'jis-a3-100',
    label: 'JIS / A3 / 1:100（住宅平面図の標準）',
    make: () => jisStandard(),
  },
  {
    id: 'jis-a2-50',
    label: 'JIS / A2 / 1:50（詳細平面図）',
    make: () => ({
      ...jisStandard(),
      preset: 'JIS A2 1:50',
      lineGroupId: '1.4',
      scale: 50,
      paperId: 'A2',
      textHeight: { room: 5, area: 3.5, dimension: 2.5, furniture: 2.5 },
    }),
  },
  {
    id: 'jis-a4-200',
    label: 'JIS / A4 / 1:200（配置図・概略）',
    make: () => ({
      ...jisStandard(),
      preset: 'JIS A4 1:200',
      lineGroupId: '0.7',
      scale: 200,
      paperId: 'A4',
      textHeight: { room: 3.5, area: 2.5, dimension: 2.5, furniture: 2.5 },
    }),
  },
  {
    id: 'madori',
    label: '間取り図（規格によらない見やすさ優先）',
    make: () => ({
      ...jisStandard(),
      preset: '間取り図',
      lineGroupId: '1.0',
      scale: 100,
      textHeight: { room: 6, area: 4, dimension: 3, furniture: 3 },
      wallFill: true,
    }),
  },
];

/** 紙の上の mm を、尺度を介してワールドの mm に直す */
export const paperToWorld = (paperMm: number, standard: DrawingStandard): number => paperMm * standard.scale;

/** 画面上の 1mm あたりのピクセル数 (96dpi 相当) */
export const PX_PER_MM = 96 / 25.4;

/**
 * 線の太さを画面のピクセルに直す。
 * CAD と同じく「紙の上の太さ」なので、ズームしても太さは変わらない。
 */
export const paperToScreenPx = (paperMm: number): number => Math.max(0.75, paperMm * PX_PER_MM);

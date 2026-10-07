import {
  LINE_TYPE_PATTERNS,
  lineGroupById,
  weightOf,
  type DrawingStandard,
  type LineType,
  type WeightRole,
} from './standard.ts';

export type LayerId = string;

/**
 * 画層。CAD との連携で実際に効くのはここで、DXF の LAYER テーブルにそのまま対応する。
 *
 * 線の太さは線群の役割 (細線/太線/極太線) で持たせてある。
 * こうしておくと線群プリセットを切り替えるだけで図面全体の太さが揃う。
 */
export interface Layer {
  id: LayerId;
  /** DXF に書き出されるレイヤ名 */
  name: string;
  /** 画面表示の色 */
  color: string;
  /** DXF の色番号 (ACI)。1=赤 2=黄 3=緑 4=水 5=青 6=紫 7=白/黒 8=濃灰 9=薄灰 */
  aci: number;
  weightRole: WeightRole;
  /** 線群によらず太さを直接指定したいとき (紙の上の mm)。null なら線群から引く */
  lineWeightOverride: number | null;
  lineType: LineType;
  visible: boolean;
  locked: boolean;
  /** 印刷・書き出しに含めるか */
  printable: boolean;
}

/** 既定の画層。id は保存ファイル中で安定させたいので固定のスラッグにしてある */
export const LAYER_IDS = {
  wall: 'wall',
  opening: 'opening',
  furniture: 'furniture',
  dimension: 'dimension',
  roomName: 'room-name',
  /** 汎用図形（線・円弧・円・ポリライン・点）の既定 */
  shape: 'shape',
  axis: 'axis',
  draft: 'draft',
} as const;

export function defaultLayers(): Record<LayerId, Layer> {
  const list: Layer[] = [
    {
      id: LAYER_IDS.wall,
      name: 'A-WALL',
      color: '#3f3f46',
      aci: 7,
      weightRole: 'thick',
      lineWeightOverride: null,
      lineType: 'continuous',
      visible: true,
      locked: false,
      printable: true,
    },
    {
      id: LAYER_IDS.opening,
      name: 'A-DOOR-WIND',
      color: '#2563eb',
      aci: 5,
      weightRole: 'thin',
      lineWeightOverride: null,
      lineType: 'continuous',
      visible: true,
      locked: false,
      printable: true,
    },
    {
      id: LAYER_IDS.furniture,
      name: 'A-FURN',
      color: '#78716c',
      aci: 8,
      weightRole: 'thin',
      lineWeightOverride: null,
      lineType: 'continuous',
      visible: true,
      locked: false,
      printable: true,
    },
    {
      id: LAYER_IDS.dimension,
      name: 'A-DIMS',
      color: '#8a7c5a',
      aci: 3,
      weightRole: 'thin',
      lineWeightOverride: null,
      lineType: 'continuous',
      visible: true,
      locked: false,
      printable: true,
    },
    {
      id: LAYER_IDS.roomName,
      name: 'A-ANNO-TEXT',
      color: '#27272a',
      aci: 7,
      weightRole: 'thin',
      lineWeightOverride: null,
      lineType: 'continuous',
      visible: true,
      locked: false,
      printable: true,
    },
    {
      id: LAYER_IDS.shape,
      name: 'A-ANNO-SYMB',
      color: '#3f3f46',
      aci: 7,
      weightRole: 'thin',
      lineWeightOverride: null,
      lineType: 'continuous',
      visible: true,
      locked: false,
      printable: true,
    },
    {
      id: LAYER_IDS.axis,
      name: 'A-GRID',
      color: '#dc2626',
      aci: 1,
      weightRole: 'thin',
      lineWeightOverride: null,
      lineType: 'center',
      visible: true,
      locked: false,
      printable: true,
    },
    {
      id: LAYER_IDS.draft,
      name: 'A-DRAFT',
      color: '#a1a1aa',
      aci: 9,
      weightRole: 'thin',
      lineWeightOverride: null,
      lineType: 'dashed',
      visible: true,
      locked: false,
      printable: false,
    },
  ];
  return Object.fromEntries(list.map((l) => [l.id, l]));
}

/** 画層の線の太さを解決する (紙の上の mm) */
export function layerWeight(layer: Layer, standard: DrawingStandard): number {
  if (layer.lineWeightOverride !== null) return layer.lineWeightOverride;
  return weightOf(lineGroupById(standard.lineGroupId), layer.weightRole);
}

/** 画層のダッシュパターンをワールドの mm に直す。実線なら空配列 */
export function layerDashWorld(layer: Layer, standard: DrawingStandard): number[] {
  return LINE_TYPE_PATTERNS[layer.lineType].map((mm) => mm * standard.scale);
}

/** 見つからない画層IDに備えた取り出し。壊れたファイルでも描画は止めない */
export function getLayer(layers: Record<LayerId, Layer>, id: LayerId | undefined, fallback: LayerId): Layer {
  return layers[id ?? ''] ?? layers[fallback] ?? Object.values(layers)[0];
}

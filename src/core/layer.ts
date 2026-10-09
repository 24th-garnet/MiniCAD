import { newId } from './id.ts';
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
  /** 用紙枠と表題欄 */
  sheet: 'sheet',
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
      id: LAYER_IDS.sheet,
      name: 'A-ANNO-TTLB',
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

/** DXF の色番号 (ACI) のうち、画層の色として実用になる範囲 */
export const ACI_COLORS: { aci: number; hex: string; label: string }[] = [
  { aci: 1, hex: '#e11d48', label: '赤' },
  { aci: 2, hex: '#ca8a04', label: '黄' },
  { aci: 3, hex: '#16a34a', label: '緑' },
  { aci: 4, hex: '#0891b2', label: '水' },
  { aci: 5, hex: '#2563eb', label: '青' },
  { aci: 6, hex: '#c026d3', label: '紫' },
  { aci: 7, hex: '#3f3f46', label: '黒' },
  { aci: 8, hex: '#52525b', label: '濃灰' },
  { aci: 9, hex: '#a1a1aa', label: '薄灰' },
];

const BUILTIN_IDS: ReadonlySet<LayerId> = new Set(Object.values(LAYER_IDS));

/**
 * 組み込みの画層は消せない。
 * `getLayer` と `DEFAULT_LAYER_FOR` のフォールバック先なので、
 * 無くなると行き場を失うエンティティが出る。
 */
export const isBuiltinLayer = (id: LayerId): boolean => BUILTIN_IDS.has(id);

/**
 * 重複しない画層名を作る。
 * DXF の LAYER テーブルは名前が一意である必要があり、重複するとマージされてしまう。
 */
export function uniqueLayerName(layers: Record<LayerId, Layer>, base: string): string {
  const taken = new Set(Object.values(layers).map((l) => l.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export function addLayer(layers: Record<LayerId, Layer>, init: Partial<Layer> = {}): Layer {
  const id = init.id ?? newId('ly');
  const layer: Layer = {
    id,
    name: uniqueLayerName(layers, init.name ?? 'A-USER'),
    color: init.color ?? '#3f3f46',
    aci: init.aci ?? 7,
    weightRole: init.weightRole ?? 'thin',
    lineWeightOverride: init.lineWeightOverride ?? null,
    lineType: init.lineType ?? 'continuous',
    visible: init.visible ?? true,
    locked: init.locked ?? false,
    printable: init.printable ?? true,
  };
  layers[id] = layer;
  return layer;
}

/** 改名。空名や重複は弾いて false を返す */
export function renameLayer(layers: Record<LayerId, Layer>, id: LayerId, name: string): boolean {
  const layer = layers[id];
  const trimmed = name.trim();
  if (!layer || !trimmed) return false;
  if (trimmed === layer.name) return false;
  if (Object.values(layers).some((l) => l.id !== id && l.name === trimmed)) return false;
  layer.name = trimmed;
  return true;
}

export function setLayerColor(layers: Record<LayerId, Layer>, id: LayerId, aci: number): boolean {
  const layer = layers[id];
  const entry = ACI_COLORS.find((c) => c.aci === aci);
  if (!layer || !entry) return false;
  layer.aci = entry.aci;
  layer.color = entry.hex;
  return true;
}

/**
 * 新しく作るエンティティを置く画層。
 * 「現在の画層」が指定されていればそれを、無ければ種別ごとの既定を使う。
 * ロックされた画層には置かない（置いた瞬間に選択できなくなるため）。
 */
export function resolveNewLayer(
  layers: Record<LayerId, Layer>,
  currentLayerId: LayerId | null,
  fallback: LayerId,
): LayerId {
  if (!currentLayerId) return fallback;
  const layer = layers[currentLayerId];
  return layer && !layer.locked ? currentLayerId : fallback;
}

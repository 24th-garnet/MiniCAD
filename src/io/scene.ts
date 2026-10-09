import { defaultLayers, LAYER_IDS, type Layer, type LayerId } from '../core/layer.ts';
import {
  jisStandard,
  lineGroupById,
  paperById,
  type DrawingStandard,
  type LineType,
  type WeightRole,
} from '../core/standard.ts';
import { createWallDimensions } from '../core/dimension.ts';
import { defaultSheet, type Sheet } from '../core/sheet.ts';
import { readShape } from './shapeRead.ts';
import { emptyScene, type Scene } from '../core/types.ts';

/**
 * 1 → 2 で画層と製図規格、2 → 3 で汎用図形、3 → 4 で寸法、4 → 5 で用紙枠が入った。
 *
 * `deserialize` は常に `emptyScene()` を土台にフィールド単位で補うので、
 * テーブルが増えるだけなら分岐は要らない。
 * 4 だけは「壁に自動表示していた寸法」を実体に変える必要があるので移行する。
 */
export const FILE_VERSION = 5;

/** 寸法が実体になる前のファイル。読み込み時に全壁ぶんの寸法を作る */
const DIMENSIONS_BECAME_ENTITIES = 4;

export interface SceneFile {
  format: 'minicad';
  version: number;
  unit: 'mm';
  savedAt: string;
  scene: Scene;
}

export function serialize(scene: Scene): SceneFile {
  return {
    format: 'minicad',
    version: FILE_VERSION,
    unit: 'mm',
    savedAt: new Date().toISOString(),
    scene,
  };
}

/** 外部から来たJSONを信用せず、必要なテーブルだけ取り出して形を整える */
export function deserialize(raw: unknown): Scene {
  if (typeof raw !== 'object' || raw === null) throw new Error('JSON の形式が不正です');
  const obj = raw as Record<string, unknown>;
  const payload = (obj.format === 'minicad' ? obj.scene : obj) as Record<string, unknown> | undefined;
  if (typeof payload !== 'object' || payload === null) throw new Error('scene が見つかりません');

  const scene = emptyScene();
  const table = <T>(key: string): Record<string, T> => {
    const v = payload[key];
    return typeof v === 'object' && v !== null ? (v as Record<string, T>) : {};
  };

  scene.layers = readLayers(table<Record<string, unknown>>('layers'));
  scene.standard = readStandard(payload.standard);
  scene.sheet = readSheet(payload.sheet);
  const layerOr = (v: unknown, fallback: LayerId): LayerId =>
    typeof v === 'string' && scene.layers[v] ? v : fallback;

  for (const [id, n] of Object.entries(table<Record<string, unknown>>('nodes'))) {
    if (typeof n?.x !== 'number' || typeof n?.y !== 'number') continue;
    scene.nodes[id] = { id, x: n.x, y: n.y };
  }
  for (const [id, w] of Object.entries(table<Record<string, unknown>>('walls'))) {
    if (typeof w?.a !== 'string' || typeof w?.b !== 'string') continue;
    if (!scene.nodes[w.a] || !scene.nodes[w.b]) continue;
    scene.walls[id] = {
      id,
      a: w.a,
      b: w.b,
      thickness: numberOr(w.thickness, 120),
      layerId: layerOr(w.layerId, LAYER_IDS.wall),
    };
  }
  for (const [id, o] of Object.entries(table<Record<string, unknown>>('openings'))) {
    if (typeof o?.wallId !== 'string' || !scene.walls[o.wallId]) continue;
    const kind = o.kind === 'window' || o.kind === 'opening' ? o.kind : 'door';
    scene.openings[id] = {
      id,
      wallId: o.wallId,
      offset: numberOr(o.offset, 0),
      width: numberOr(o.width, 800),
      kind,
      flipX: o.flipX === true,
      flipY: o.flipY === true,
      layerId: layerOr(o.layerId, LAYER_IDS.opening),
    };
  }
  for (const [id, f] of Object.entries(table<Record<string, unknown>>('furniture'))) {
    if (typeof f?.x !== 'number' || typeof f?.y !== 'number') continue;
    scene.furniture[id] = {
      id,
      kind: (typeof f.kind === 'string' ? f.kind : 'generic') as Scene['furniture'][string]['kind'],
      name: typeof f.name === 'string' ? f.name : '家具',
      x: f.x,
      y: f.y,
      w: numberOr(f.w, 600),
      h: numberOr(f.h, 600),
      angle: numberOr(f.angle, 0),
      layerId: layerOr(f.layerId, LAYER_IDS.furniture),
    };
  }
  for (const [id, raw] of Object.entries(table<Record<string, unknown>>('shapes'))) {
    const shape = readShape(id, raw, layerOr(raw?.layerId, LAYER_IDS.shape));
    if (shape) scene.shapes[id] = shape;
  }
  migrateDimensions(scene, obj);

  for (const [id, l] of Object.entries(table<Record<string, unknown>>('roomLabels'))) {
    if (typeof l?.x !== 'number' || typeof l?.y !== 'number') continue;
    scene.roomLabels[id] = {
      id,
      x: l.x,
      y: l.y,
      name: typeof l.name === 'string' ? l.name : '部屋',
      layerId: layerOr(l.layerId, LAYER_IDS.roomName),
    };
  }
  return scene;
}

/**
 * 寸法が「全壁への自動表示」だった頃のファイルを、寸法エンティティへ変える。
 *
 * MiniCAD が書いたファイル（format: 'minicad'）でバージョンが古いときだけ走る。
 * 手書きの JSON やテストのリテラルは現行版として扱い、勝手に寸法を生やさない。
 */
function migrateDimensions(scene: Scene, raw: Record<string, unknown>): void {
  if (raw.format !== 'minicad') return;
  const version = typeof raw.version === 'number' ? raw.version : 1;
  if (version >= DIMENSIONS_BECAME_ENTITIES) return;
  for (const dim of createWallDimensions(scene)) scene.shapes[dim.id] = dim;
}

/** 既定の画層を土台に、ファイル側の値で上書きする。知らない画層は追加で受け入れる */
function readLayers(raw: Record<string, Record<string, unknown>>): Record<LayerId, Layer> {
  const layers = defaultLayers();
  const lineTypes: LineType[] = ['continuous', 'dashed', 'hidden', 'center', 'phantom'];
  const roles: WeightRole[] = ['thin', 'thick', 'extraThick'];

  for (const [id, l] of Object.entries(raw)) {
    if (typeof l !== 'object' || l === null) continue;
    const base = layers[id];
    layers[id] = {
      id,
      name: typeof l.name === 'string' ? l.name : (base?.name ?? id),
      color: typeof l.color === 'string' ? l.color : (base?.color ?? '#3f3f46'),
      aci: clampInt(l.aci, base?.aci ?? 7, 0, 255),
      weightRole: roles.includes(l.weightRole as WeightRole)
        ? (l.weightRole as WeightRole)
        : (base?.weightRole ?? 'thin'),
      lineWeightOverride:
        typeof l.lineWeightOverride === 'number' && Number.isFinite(l.lineWeightOverride)
          ? l.lineWeightOverride
          : null,
      lineType: lineTypes.includes(l.lineType as LineType)
        ? (l.lineType as LineType)
        : (base?.lineType ?? 'continuous'),
      visible: l.visible !== false,
      locked: l.locked === true,
      printable: l.printable !== false,
    };
  }
  return layers;
}

function readStandard(raw: unknown): DrawingStandard {
  const base = jisStandard();
  if (typeof raw !== 'object' || raw === null) return base;
  const s = raw as Record<string, unknown>;
  const text = (typeof s.textHeight === 'object' && s.textHeight !== null
    ? s.textHeight
    : {}) as Record<string, unknown>;
  return {
    preset: typeof s.preset === 'string' ? s.preset : base.preset,
    // 不正な値は lineGroupById / paperById が既定にまとめてくれる
    lineGroupId: lineGroupById(String(s.lineGroupId ?? base.lineGroupId)).id,
    scale: numberOr(s.scale, base.scale) > 0 ? numberOr(s.scale, base.scale) : base.scale,
    textHeight: {
      room: numberOr(text.room, base.textHeight.room),
      area: numberOr(text.area, base.textHeight.area),
      dimension: numberOr(text.dimension, base.textHeight.dimension),
      furniture: numberOr(text.furniture, base.textHeight.furniture),
    },
    paperId: paperById(String(s.paperId ?? base.paperId)).id,
    orientation: s.orientation === 'portrait' ? 'portrait' : 'landscape',
    wallFill: s.wallFill !== false,
  };
}

function readSheet(raw: unknown): Sheet {
  const base = defaultSheet();
  if (typeof raw !== 'object' || raw === null) return base;
  const s = raw as Record<string, unknown>;
  const block = (typeof s.titleBlock === 'object' && s.titleBlock !== null ? s.titleBlock : {}) as Record<string, unknown>;
  const fields = (typeof block.fields === 'object' && block.fields !== null ? block.fields : {}) as Record<string, unknown>;
  const origin = (typeof s.origin === 'object' && s.origin !== null ? s.origin : {}) as Record<string, unknown>;
  const margins = (typeof s.margins === 'object' && s.margins !== null ? s.margins : null) as Record<string, unknown> | null;
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);

  return {
    show: s.show === true,
    origin: {
      x: numberOr(origin.x, base.origin.x),
      y: numberOr(origin.y, base.origin.y),
    },
    margins: margins
      ? {
          binding: numberOr(margins.binding, 20),
          top: numberOr(margins.top, 10),
          right: numberOr(margins.right, 10),
          bottom: numberOr(margins.bottom, 10),
        }
      : null,
    titleBlock: {
      enabled: block.enabled !== false,
      width: numberOr(block.width, base.titleBlock.width),
      rowHeight: numberOr(block.rowHeight, base.titleBlock.rowHeight),
      fields: {
        drawingName: str(fields.drawingName, base.titleBlock.fields.drawingName),
        drawingNumber: str(fields.drawingNumber, ''),
        company: str(fields.company, ''),
        designer: str(fields.designer, ''),
        date: str(fields.date, ''),
      },
    },
  };
}

const numberOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

export function downloadJson(scene: Scene, filename = 'madori.minicad.json'): void {
  const blob = new Blob([JSON.stringify(serialize(scene), null, 2)], { type: 'application/json' });
  triggerDownload(blob, filename);
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // revoke はクリック処理が済んでから
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const STORAGE_KEY = 'minicad.autosave.v1';

export function saveLocal(scene: Scene): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize(scene)));
  } catch {
    // 容量超過やプライベートモードでは黙って諦める
  }
}

export function loadLocal(): Scene | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return deserialize(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function clearLocal(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 無視
  }
}

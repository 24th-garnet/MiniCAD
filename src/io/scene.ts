import { defaultLayers, LAYER_IDS, type Layer, type LayerId } from '../core/layer.ts';
import {
  jisStandard,
  lineGroupById,
  paperById,
  type DrawingStandard,
  type LineType,
  type WeightRole,
} from '../core/standard.ts';
import { readShape } from './shapeRead.ts';
import { emptyScene, type Scene } from '../core/types.ts';

/**
 * 1 → 2 で画層と製図規格、2 → 3 で汎用図形が入った。
 * `deserialize` は常に `emptyScene()` を土台にフィールド単位で補うので、
 * 古いファイルはバージョン分岐なしでそのまま読める。
 */
export const FILE_VERSION = 3;

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

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
import type { BlockDef } from '../core/block.ts';
import { BLOCK_PRESETS } from '../core/blockPresets.ts';
import type { Shape } from '../core/shapes.ts';
import type { Id } from '../core/id.ts';
import { readShape } from './shapeRead.ts';
import { FIXTURE_SPECS, isFixtureKind } from '../core/fixture.ts';
import { isBayShape, type Bay } from '../core/bay.ts';
import { readPoint3 } from '../core/annotation.ts';
import { emptyScene, isOpeningKind, type Scene } from '../core/types.ts';
import { CONSTRAINT_SPECS, isConstraintKind } from '../core/constraints.ts';
import { defaultAttrs, isTakeoffMode, type Attrs } from '../core/attrs.ts';
import { DEFAULT_LEVEL_ID, defaultLevel, levelsInOrder, type Level } from '../core/level.ts';

/**
 * 1 → 2 で画層と製図規格、2 → 3 で汎用図形、3 → 4 で寸法、4 → 5 で用紙枠、
 * 5 → 6 で家具がブロック、6 → 7 で幾何拘束、7 → 8 で高さ（壁・建具・階）、
 * 8 → 9 で階が複数。
 *
 * `deserialize` は常に `emptyScene()` を土台にフィールド単位で補うので、
 * テーブルが増えるだけなら分岐は要らない。
 * 4 だけは「壁に自動表示していた寸法」を実体に変える必要があるので移行する。
 *
 * 8 → 9 も分岐は要らない。単数の `level` を 1 件の `levels` に読み替え、
 * `levelId` の無い実体は**既定の階に乗せる**だけで済む。
 * `DEFAULT_LEVEL_ID` が固定値なのはこのため。
 */
export const FILE_VERSION = 10;

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
  readLevels(scene, payload);
  const layerOr = (v: unknown, fallback: LayerId): LayerId =>
    typeof v === 'string' && scene.layers[v] ? v : fallback;
  /** 知らない階に乗っている実体は作業中の階へ。宙に浮かせるより直しようがある */
  const levelOr = (v: unknown): Id =>
    typeof v === 'string' && scene.levels[v] ? v : scene.activeLevelId;

  for (const [id, n] of Object.entries(table<Record<string, unknown>>('nodes'))) {
    if (typeof n?.x !== 'number' || typeof n?.y !== 'number') continue;
    scene.nodes[id] = { id, x: n.x, y: n.y, levelId: levelOr(n.levelId) };
  }
  for (const [id, w] of Object.entries(table<Record<string, unknown>>('walls'))) {
    if (typeof w?.a !== 'string' || typeof w?.b !== 'string') continue;
    const na = scene.nodes[w.a];
    const nb = scene.nodes[w.b];
    // **壁は両端ノードと同じ階に乗る。** 食い違う JSON は壁ごと落とす
    if (!na || !nb || na.levelId !== nb.levelId) continue;
    scene.walls[id] = {
      id,
      a: w.a,
      b: w.b,
      thickness: numberOr(w.thickness, 120),
      height: finiteOrNull(w.height),
      // 下端は負にならない。古いファイルには欄が無く、床に着く
      base: Math.max(0, numberOr(w.base, 0)),
      layerId: layerOr(w.layerId, LAYER_IDS.wall),
      levelId: na.levelId,
      attrs: readAttrs(w.attrs),
    };
  }
  for (const [id, o] of Object.entries(table<Record<string, unknown>>('openings'))) {
    if (typeof o?.wallId !== 'string' || !scene.walls[o.wallId]) continue;
    // 表引きにしておかないと、種別を足したときに読み込みで 'door' に化けて静かに壊れる
    const kind = isOpeningKind(o.kind) ? o.kind : 'door';
    scene.openings[id] = {
      id,
      wallId: o.wallId,
      offset: numberOr(o.offset, 0),
      width: numberOr(o.width, 800),
      kind,
      flipX: o.flipX === true,
      flipY: o.flipY === true,
      sillHeight: finiteOrNull(o.sillHeight),
      bay: readBay(o.bay),
      designation: typeof o.designation === 'string' ? o.designation.trim() : '',
      // 枚数は 1 以上の整数。引違いの既定は 2 枚
      leaves: Math.max(1, Math.round(numberOr(o.leaves, 2))),
      height: finiteOrNull(o.height),
      layerId: layerOr(o.layerId, LAYER_IDS.opening),
      attrs: readAttrs(o.attrs),
    };
  }
  for (const [id, b] of Object.entries(table<Record<string, unknown>>('blocks'))) {
    const def = readBlockDef(id, b, scene);
    if (def) scene.blocks[id] = def;
  }
  for (const [id, i] of Object.entries(table<Record<string, unknown>>('instances'))) {
    if (typeof i?.blockId !== 'string' || !scene.blocks[i.blockId]) continue;
    if (typeof i.x !== 'number' || typeof i.y !== 'number') continue;
    scene.instances[id] = {
      id,
      blockId: i.blockId,
      layerId: layerOr(i.layerId, LAYER_IDS.furniture),
      x: i.x,
      y: i.y,
      scaleX: numberOr(i.scaleX, 1) || 1,
      scaleY: numberOr(i.scaleY, 1) || 1,
      angle: numberOr(i.angle, 0),
      label: typeof i.label === 'string' ? i.label : null,
      levelId: levelOr(i.levelId),
      attrs: readAttrs(i.attrs),
    };
  }
  migrateFurniture(scene, table<Record<string, unknown>>('furniture'), layerOr, scene.activeLevelId);
  for (const [id, raw] of Object.entries(table<Record<string, unknown>>('shapes'))) {
    const shape = readShape(
      {
        id,
        layerId: layerOr(raw?.layerId, LAYER_IDS.shape),
        levelId: levelOr(raw?.levelId),
        attrs: readAttrs(raw?.attrs),
      },
      raw,
    );
    if (shape) scene.shapes[id] = shape;
  }
  migrateDimensions(scene, obj);

  for (const [id, c] of Object.entries(table<Record<string, unknown>>('constraints'))) {
    if (!isConstraintKind(c?.kind)) continue;
    const walls = Array.isArray(c.walls) ? c.walls.filter((w): w is string => typeof w === 'string') : [];
    const spec = CONSTRAINT_SPECS[c.kind];
    // 参照先の壁が実在するものだけ採る（開口が壁を検査するのと同じ作法）
    if (!spec.applicable(scene, walls)) continue;
    scene.constraints[id] = {
      id,
      kind: c.kind,
      walls,
      value: spec.usesValue ? numberOr(c.value, spec.initialValue(scene, walls) ?? 0) : null,
    };
  }

  for (const [id, raw] of Object.entries(table<Record<string, unknown>>('fixtures'))) {
    if (!isFixtureKind(raw?.kind)) continue;
    if (typeof raw.x !== 'number' || typeof raw.y !== 'number') continue;
    const spec = FIXTURE_SPECS[raw.kind];
    const size = (typeof raw.size === 'object' && raw.size !== null ? raw.size : {}) as Record<string, unknown>;
    const w = Math.max(1, numberOr(size.w, spec.defaultSize.w));
    scene.fixtures[id] = {
      id,
      kind: raw.kind,
      x: raw.x,
      y: raw.y,
      angle: numberOr(raw.angle, 0),
      // 円柱は直径 1 つで決まる。奥行が別の値で書かれていても直径に揃える
      size: { w, h: raw.kind === 'roundColumn' ? w : Math.max(1, numberOr(size.h, spec.defaultSize.h)) },
      base: typeof raw.base === 'number' ? raw.base : null,
      height: typeof raw.height === 'number' ? raw.height : null,
      label: typeof raw.label === 'string' ? raw.label : spec.defaultLabel,
      layerId: layerOr(raw.layerId, spec.defaultLayer),
      levelId: levelOr(raw.levelId),
      attrs: readAttrs(raw.attrs),
    };
  }

  for (const [id, raw] of Object.entries(table<Record<string, unknown>>('measurements'))) {
    const a = readPoint3(raw?.a);
    const b = readPoint3(raw?.b);
    if (!a || !b) continue;
    scene.measurements[id] = {
      id,
      a,
      b,
      // 手入力は数値のときだけ。**未入力と 0 を分ける**
      manual: typeof raw.manual === 'number' && Number.isFinite(raw.manual) ? raw.manual : null,
      note: typeof raw.note === 'string' ? raw.note : '',
      layerId: layerOr(raw.layerId, LAYER_IDS.draft),
      levelId: levelOr(raw.levelId),
      attrs: readAttrs(raw.attrs),
    };
  }

  for (const [id, l] of Object.entries(table<Record<string, unknown>>('roomLabels'))) {
    if (typeof l?.x !== 'number' || typeof l?.y !== 'number') continue;
    scene.roomLabels[id] = {
      id,
      x: l.x,
      y: l.y,
      name: typeof l.name === 'string' ? l.name : '部屋',
      floorMaterial: typeof l.floorMaterial === 'string' ? l.floorMaterial : null,
      ceilingMaterial: typeof l.ceilingMaterial === 'string' ? l.ceilingMaterial : null,
      layerId: layerOr(l.layerId, LAYER_IDS.roomName),
      levelId: levelOr(l.levelId),
    };
  }
  return scene;
}

/**
 * 出窓・ニッチの読み取り。出が 0 なら無いものと同じなので null に落とす。
 * **種別を増やしていない**ので、古いファイルは欄が無く、そのまま null になる
 */
function readBay(raw: unknown): Bay | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (!isBayShape(b.shape)) return null;
  const depth = numberOr(b.depth, 0);
  if (Math.abs(depth) < 1e-6) return null;
  return { shape: b.shape, depth, side: b.side === -1 ? -1 : 1 };
}

/** ブロック定義の読み取り。中身の図形は既定の画層・既定の階に乗せる（どちらも定義の中では意味を持たない） */
function readBlockDef(id: Id, raw: unknown, scene: Scene): BlockDef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.name !== 'string' || typeof b.label !== 'string') return null;
  const size = (typeof b.size === 'object' && b.size !== null ? b.size : {}) as Record<string, unknown>;
  const shapes: Record<Id, Shape> = {};
  const rawShapes = typeof b.shapes === 'object' && b.shapes !== null ? (b.shapes as Record<string, unknown>) : {};
  for (const [shapeId, rawShape] of Object.entries(rawShapes)) {
    const shape = readShape(
      { id: shapeId, layerId: LAYER_IDS.furniture, levelId: DEFAULT_LEVEL_ID, attrs: defaultAttrs() },
      rawShape,
    );
    if (shape) shapes[shapeId] = shape;
  }
  if (Object.keys(shapes).length === 0) return null;
  void scene;
  return {
    id,
    name: b.name,
    label: b.label,
    size: { w: numberOr(size.w, 1), h: numberOr(size.h, 1) },
    shapes,
    source: b.source === 'builtin' ? 'builtin' : 'user',
  };
}

/**
 * 家具が専用のエンティティだった頃のファイルを、ブロックの挿入に変える。
 *
 * 旧 `kind` は標準ブロックに1対1で対応する。
 * 幅と奥行は定義の自然な大きさとの比を尺度にして、見た目を保つ。
 */
function migrateFurniture(
  scene: Scene,
  furniture: Record<string, Record<string, unknown>>,
  layerOr: (v: unknown, fallback: LayerId) => LayerId,
  levelId: Id,
): void {
  for (const [id, f] of Object.entries(furniture)) {
    if (typeof f?.x !== 'number' || typeof f?.y !== 'number') continue;
    const name = typeof f.name === 'string' ? f.name : '';
    const preset =
      BLOCK_PRESETS.find((p) => p.label === name) ??
      BLOCK_PRESETS.find((p) => p.id.startsWith(String(f.kind ?? ''))) ??
      BLOCK_PRESETS.find((p) => p.id === 'box')!;
    const def = scene.blocks[preset.id];
    if (!def) continue;
    scene.instances[id] = {
      id,
      blockId: preset.id,
      layerId: layerOr(f.layerId, LAYER_IDS.furniture),
      x: f.x,
      y: f.y,
      scaleX: numberOr(f.w, def.size.w) / def.size.w,
      scaleY: numberOr(f.h, def.size.h) / def.size.h,
      angle: numberOr(f.angle, 0),
      label: name && name !== preset.label ? name : null,
      levelId,
      attrs: defaultAttrs(),
    };
  }
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

/**
 * 階の読み取り。**版 8 までの単数の `level` も受ける。**
 *
 * 古いファイルは `level: {floorZ, wallHeight}` を 1 つだけ持つので、
 * それを `DEFAULT_LEVEL_ID` の階として読む。id が固定値なので、
 * `levelId` を持たない実体の行き先が一意に決まる。
 */
function readLevels(scene: Scene, payload: Record<string, unknown>): void {
  const raw = payload.levels;
  const table = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;

  if (table && Object.keys(table).length > 0) {
    const levels: Record<Id, Level> = {};
    for (const [id, l] of Object.entries(table)) {
      levels[id] = readLevel(id, l);
    }
    scene.levels = levels;
    const active = payload.activeLevelId;
    scene.activeLevelId =
      typeof active === 'string' && levels[active] ? active : levelsInOrder(scene)[0]!.id;
    return;
  }

  // 版 8 以前。単数の level を 1 件の階に読み替える
  scene.levels = { [DEFAULT_LEVEL_ID]: readLevel(DEFAULT_LEVEL_ID, payload.level) };
  scene.activeLevelId = DEFAULT_LEVEL_ID;
}

/**
 * 属性の読み取り。**欄ごとに検査する。**
 *
 * `takeoff` だけは閉じた語彙なので表引きで弾く。知らない値を黙って通すと、
 * その行が何を名乗っているか決まらなくなる（`isOpeningKind` と同じ作法）。
 * 残りはホストの識別子や色文字列で、MiniCAD は中身を解釈しない。
 */
function readAttrs(raw: unknown): Attrs {
  const a = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  return {
    groupId: str(a.groupId),
    color: str(a.color),
    materialRef: str(a.materialRef),
    takeoff: isTakeoffMode(a.takeoff) ? a.takeoff : null,
    symbolId: str(a.symbolId),
  };
}

function readLevel(id: Id, raw: unknown): Level {
  const base = defaultLevel();
  const l = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    id,
    name: typeof l.name === 'string' && l.name.trim() !== '' ? l.name : base.name,
    floorZ: numberOr(l.floorZ, base.floorZ),
    wallHeight: Math.max(1, numberOr(l.wallHeight, base.wallHeight)),
  };
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

/** 上書きがあればその値、無ければ null。「既定に従う」を null 1値で表す既存の流儀に合わせる */
const finiteOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

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
  saveLocalFile(serialize(scene));
}

/** 書き出し済みのものをそのまま保存する。ホストが `onChange` で受け取った形 */
export function saveLocalFile(file: SceneFile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
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

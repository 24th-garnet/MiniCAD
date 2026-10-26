import type { Attrs } from './attrs.ts';
import type { Vec } from './geometry.ts';
import { newId, type Id } from './id.ts';
import { defaultLayers, LAYER_IDS, type Layer, type LayerId } from './layer.ts';
import type { Shape } from './shapes.ts';
import type { BlockDef, BlockInstance } from './block.ts';
import type { Constraint } from './constraints.ts';
import type { Fixture } from './fixture.ts';
import { DEFAULT_LEVEL_ID, defaultLevels, type Level } from './level.ts';
import { builtinBlocks } from './blockPresets.ts';
import { defaultSheet, type Sheet } from './sheet.ts';
import { jisStandard, type DrawingStandard } from './standard.ts';

export { newId };
export type { Id };

/**
 * 壁の端点。複数の壁から共有されるので、動かすと接続した壁がすべて追従する。
 *
 * **階を持つ。** 距離だけで同一視すると、1 階と 2 階の同じ座標の角が
 * 1 つのノードに溶けて、片方を動かすともう片方も動く。
 */
export interface Node {
  id: Id;
  x: number;
  y: number;
  levelId: Id;
}

export interface Wall {
  id: Id;
  /** 始点ノード */
  a: Id;
  /** 終点ノード */
  b: Id;
  /** 壁厚 (mm) */
  thickness: number;
  /** 壁の高さ (mm)。null なら階の既定 */
  height: number | null;
  layerId: LayerId;
  /** 乗っている階。**両端ノードと必ず一致する** */
  levelId: Id;
  attrs: Attrs;
}

/**
 * 建具の種別。JIS A 0150 の平面表示記号に対応する。
 *
 * 配列を種別の唯一の出どころにしてあるので、ここに足せば
 * `OPENING_SYMBOLS`（core/opening.ts）の埋め忘れが型エラーになる。
 */
export const OPENING_KINDS = [
  'door',
  'doubleDoor',
  'unequalDoor',
  'slidingDouble',
  'slidingSingle',
  'slidingPocket',
  'folding',
  'opening',
  'window',
  'windowSliding',
] as const;

export type OpeningKind = (typeof OPENING_KINDS)[number];

const OPENING_KIND_SET: ReadonlySet<string> = new Set<string>(OPENING_KINDS);

export const isOpeningKind = (v: unknown): v is OpeningKind =>
  typeof v === 'string' && OPENING_KIND_SET.has(v);

/** 壁に開ける穴（ドア・窓）。壁の始点からの距離で位置を持つので、壁を伸ばしてもズレない */
export interface Opening {
  id: Id;
  wallId: Id;
  /** 壁の始点ノードから開口中心までの距離 (mm) */
  offset: number;
  /** 開口幅 (mm) */
  width: number;
  kind: OpeningKind;
  /** ドアの開き勝手を反転 */
  flipX: boolean;
  flipY: boolean;
  /** 窓台の高さ＝床から開口下端 (mm)。null なら建具種別の既定 */
  sillHeight: number | null;
  /** 開口の高さ (mm)。null なら建具種別の既定 */
  height: number | null;
  layerId: LayerId;
  attrs: Attrs;
}

/** 部屋名の手動ラベル。部屋ポリゴン自体は壁から自動検出する */
export interface RoomLabel {
  id: Id;
  /** 部屋の内部に置かれた点。この点を含む検出済み部屋に名前が付く */
  x: number;
  y: number;
  name: string;
  layerId: LayerId;
  levelId: Id;
}

export interface Scene {
  nodes: Record<Id, Node>;
  walls: Record<Id, Wall>;
  openings: Record<Id, Opening>;
  roomLabels: Record<Id, RoomLabel>;
  /** 間取りの意味を持たない汎用図形（線・円弧・円・ポリライン・文字・点） */
  shapes: Record<Id, Shape>;
  /** 構造物（柱・梁・階段・スロープ・吹抜）。壁グラフには参加しない */
  fixtures: Record<Id, Fixture>;
  /** 画層。DXF の LAYER テーブルに対応する */
  layers: Record<LayerId, Layer>;
  /** 線群・尺度・文字高さなどの製図規格。図面の属性なのでシーンと一緒に保存する */
  standard: DrawingStandard;
  /** 用紙枠と表題欄。これも図面の属性 */
  sheet: Sheet;
  /** ブロック定義。標準のものは起動時に入る */
  blocks: Record<Id, BlockDef>;
  /** ブロックの挿入 */
  instances: Record<Id, BlockInstance>;
  /** 幾何拘束。対象は壁（ノードではない。constraints.ts の冒頭を参照） */
  constraints: Record<Id, Constraint>;
  /** 階。下から順に見たいときは `levelsInOrder` */
  levels: Record<Id, Level>;
  /** 作業中の階。新しく描いたものがここに乗る */
  activeLevelId: Id;
}

export function emptyScene(): Scene {
  return {
    nodes: {},
    walls: {},
    openings: {},
    roomLabels: {},
    shapes: {},
    fixtures: {},
    layers: defaultLayers(),
    standard: jisStandard(),
    sheet: defaultSheet(),
    blocks: builtinBlocks(),
    instances: {},
    constraints: {},
    levels: defaultLevels(),
    activeLevelId: DEFAULT_LEVEL_ID,
  };
}

/** エンティティの種類から既定の画層を引く */
export const DEFAULT_LAYER_FOR: Record<Exclude<EntityType, 'node'>, LayerId> = {
  wall: LAYER_IDS.wall,
  opening: LAYER_IDS.opening,
  blockInstance: LAYER_IDS.furniture,
  roomLabel: LAYER_IDS.roomName,
  shape: LAYER_IDS.shape,
  fixture: LAYER_IDS.wall,
};

export type EntityType =
  | 'node'
  | 'wall'
  | 'opening'
  | 'blockInstance'
  | 'roomLabel'
  | 'shape'
  | 'fixture';

export interface EntityRef {
  type: EntityType;
  id: Id;
}

export const sameRef = (a: EntityRef | null, b: EntityRef | null): boolean =>
  a !== null && b !== null && a.type === b.type && a.id === b.id;

/** 自動検出された部屋（シーンには保存されない派生データ） */
export interface Room {
  /** 壁芯を結んだポリゴン（反時計回り） */
  polygon: Vec[];
  /** 壁厚を考慮した内法ポリゴン */
  innerPolygon: Vec[];
  /** 壁芯面積 (m^2) */
  area: number;
  /** 内法面積 (m^2) */
  innerArea: number;
  center: Vec;
  wallIds: Id[];
  name: string | null;
  labelId: Id | null;
}


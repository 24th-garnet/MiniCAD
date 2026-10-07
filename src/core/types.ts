import type { Vec } from './geometry.ts';
import { defaultLayers, LAYER_IDS, type Layer, type LayerId } from './layer.ts';
import type { Shape } from './shapes.ts';
import { jisStandard, type DrawingStandard } from './standard.ts';

export type Id = string;

/** 壁の端点。複数の壁から共有されるので、動かすと接続した壁がすべて追従する */
export interface Node {
  id: Id;
  x: number;
  y: number;
}

export interface Wall {
  id: Id;
  /** 始点ノード */
  a: Id;
  /** 終点ノード */
  b: Id;
  /** 壁厚 (mm) */
  thickness: number;
  layerId: LayerId;
}

export type OpeningKind = 'door' | 'window' | 'opening';

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
  layerId: LayerId;
}

export type FurnitureKind =
  | 'generic'
  | 'bed'
  | 'table'
  | 'sofa'
  | 'chair'
  | 'toilet'
  | 'bath'
  | 'sink'
  | 'kitchen'
  | 'stairs';

export interface Furniture {
  id: Id;
  kind: FurnitureKind;
  name: string;
  /** 中心座標 (mm) */
  x: number;
  y: number;
  /** 幅・奥行 (mm) */
  w: number;
  h: number;
  /** 回転角 (rad) */
  angle: number;
  layerId: LayerId;
}

/** 部屋名の手動ラベル。部屋ポリゴン自体は壁から自動検出する */
export interface RoomLabel {
  id: Id;
  /** 部屋の内部に置かれた点。この点を含む検出済み部屋に名前が付く */
  x: number;
  y: number;
  name: string;
  layerId: LayerId;
}

export interface Scene {
  nodes: Record<Id, Node>;
  walls: Record<Id, Wall>;
  openings: Record<Id, Opening>;
  furniture: Record<Id, Furniture>;
  roomLabels: Record<Id, RoomLabel>;
  /** 間取りの意味を持たない汎用図形（線・円弧・円・ポリライン・文字・点） */
  shapes: Record<Id, Shape>;
  /** 画層。DXF の LAYER テーブルに対応する */
  layers: Record<LayerId, Layer>;
  /** 線群・尺度・文字高さなどの製図規格。図面の属性なのでシーンと一緒に保存する */
  standard: DrawingStandard;
}

export function emptyScene(): Scene {
  return {
    nodes: {},
    walls: {},
    openings: {},
    furniture: {},
    roomLabels: {},
    shapes: {},
    layers: defaultLayers(),
    standard: jisStandard(),
  };
}

/** エンティティの種類から既定の画層を引く */
export const DEFAULT_LAYER_FOR: Record<Exclude<EntityType, 'node'>, LayerId> = {
  wall: LAYER_IDS.wall,
  opening: LAYER_IDS.opening,
  furniture: LAYER_IDS.furniture,
  roomLabel: LAYER_IDS.roomName,
  shape: LAYER_IDS.shape,
};

export type EntityType = 'node' | 'wall' | 'opening' | 'furniture' | 'roomLabel' | 'shape';

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

let counter = 0;
export function newId(prefix: string): Id {
  counter += 1;
  return `${prefix}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

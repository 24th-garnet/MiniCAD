import type { Attrs } from './attrs.ts';
import type { Bay } from './bay.ts';
import type { Vec } from './geometry.ts';
import { newId, type Id } from './id.ts';
import { defaultLayers, LAYER_IDS, type Layer, type LayerId } from './layer.ts';
import type { Shape } from './shapes.ts';
import type { BlockDef, BlockInstance } from './block.ts';
import type { Constraint } from './constraints.ts';
import type { Fixture } from './fixture.ts';
import type { Measurement } from './annotation.ts';
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
  /**
   * 床からの下端 (mm)。0 なら床に着く。
   *
   * **垂れ壁・腰壁・カウンターを、ツールを増やさずに出すための欄**
   * （ワイヤーの奥谷さんの「床からの距離を足してツール数を減らす」）。
   * 下端 1900 / 高さ 500 なら垂れ壁、下端 0 / 高さ 900 なら腰壁。
   *
   * **床に着かない壁は部屋を仕切らない。** LDK とキッチンのあいだの垂れ壁で
   * 部屋が 2 つに割れると、床の数量が合わなくなる。`core/rooms.ts` を参照
   */
  base: number;
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
  /**
   * 壁から張り出す出窓、または内へ凹むニッチ。無ければ null。
   *
   * **種別（`OpeningKind`）を増やさずに済ませるための欄。** JIS の平面では
   * 出窓も普通の窓も同じ記号で、違うのは張り出す箱の方。`core/bay.ts` を参照
   */
  bay: Bay | null;
  /**
   * 建具符号（`AW-1`、`SD-2` など）。空なら付けない。
   *
   * **平面の記号を増やさずに、下流が区別するための札。** 上げ下げ・FIX・
   * すべり出しは JIS A 0150 の平面では**同じ記号**なので、種別を足しても
   * 図面は変わらず、記号の表に同じものが並ぶだけ。違いは符号で持ち、
   * 積算と建具表がそれを読む。
   */
  designation: string;
  /**
   * 建具の枚数。引違いの召し合わせの数を決める。
   *
   * **枚数で記号が変わる種別にだけ意味がある**（`OpeningSymbol.usesLeaves`）。
   * 4 枚建ての引違い窓のために、種別を 1 つ増やすのは割に合わない。
   */
  leaves: number;
  layerId: LayerId;
  attrs: Attrs;
}

/**
 * 部屋名の手動ラベル。部屋ポリゴン自体は壁から自動検出する。
 *
 * **床と天井の仕上げの、耐久するアンカーでもある。**
 * `Room` は壁から導く派生データで id を持たず、`measures.ts` は
 * `room.labelId ?? \`r${index+1}\`` という**位置依存の id** に落ちる。
 * 壁を 1 本足して部屋の並びが変わると、r2 に貼った床が r3 のものになる。
 * ラベルは実体で id を持つので、そこに紐づけたものは動かない。
 *
 * **床と天井は部屋のもので、どの実体のものでもない。** 壁の仕上げは壁
 * （実体）が持てるが、床と天井には持ち主がいない。だから欄が 2 つだけ
 * ここに来る。巾木や回り縁は面から導く量なので、持ち主は要らない。
 */
export interface RoomLabel {
  id: Id;
  /** 部屋の内部に置かれた点。この点を含む検出済み部屋に名前が付く */
  x: number;
  y: number;
  name: string;
  /** 床の仕上げ。ホストの不透明な識別子。null なら指定なし */
  floorMaterial: string | null;
  /** 天井の仕上げ。同上 */
  ceilingMaterial: string | null;
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
  /** 距離計測。図面ではなく打ち合わせの道具なので、紙には出さない */
  measurements: Record<Id, Measurement>;
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
    measurements: {},
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
  measurement: LAYER_IDS.draft,
};

export type EntityType =
  | 'node'
  | 'wall'
  | 'opening'
  | 'blockInstance'
  | 'roomLabel'
  | 'shape'
  | 'fixture'
  | 'measurement';

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
  /** 内法面積 (m^2)。**吹抜を含む** */
  innerArea: number;
  /**
   * この部屋の中にある吹抜・PS・煙道の合計 (m^2)。
   *
   * **`innerArea` から引いていない。** 内法面積は壁の内側の広さで、
   * 床面積とは別の数字。引いてしまうと「内法」の意味が変わり、
   * 立面図・DXF・下流の積算が同じ名前で違うものを読むことになる。
   * 床面積が要るところは `floorArea` を使う
   */
  voidArea: number;
  /** 床の面積 (m^2)。内法面積から吹抜を引いたもの */
  floorArea: number;
  center: Vec;
  wallIds: Id[];
  name: string | null;
  labelId: Id | null;
}


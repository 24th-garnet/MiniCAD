import type { Attrs } from "./attrs.ts";
import type { Bay } from "./bay.ts";
import type { Vec } from "./geometry.ts";
import { newId, type Id } from "./id.ts";
import { defaultLayers, LAYER_IDS, type Layer, type LayerId } from "./layer.ts";
import type { Shape } from "./shapes.ts";
import type { BlockDef, BlockInstance } from "./block.ts";
import type { Constraint } from "./constraints.ts";
import type { Fixture } from "./fixture.ts";
import type { Measurement } from "./annotation.ts";
import type { Assembly, Stamp } from "./assembly.ts";
import { DEFAULT_VIEW_ID, initialViews, type DrawingView } from "./view.ts";
import { DEFAULT_LEVEL_ID, defaultLevels, type Level } from "./level.ts";
import { builtinBlocks } from "./blockPresets.ts";
import { defaultSheet, type Sheet } from "./sheet.ts";
import { jisStandard, type DrawingStandard } from "./standard.ts";

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
  /**
   * 円弧壁の膨らみ。**0 なら直線**（ワイヤー 5 枚目「円弧壁」）。
   *
   * `bulge = tan(掃過角 / 4)` で、DXF の `LWPOLYLINE` と同じ流儀。
   * **中心と半径は持たない**——持つと端点を動かした瞬間に矛盾する。
   * 中心は `core/geometry.ts` の `arcFromBulge` が毎回導く。
   *
   * **正なら反時計回りで、弧は進行方向の右へ膨らむ**（中心が左にあるため）。
   */
  bulge: number;
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
  "door",
  "doubleDoor",
  "unequalDoor",
  "slidingDouble",
  "slidingSingle",
  "slidingPocket",
  "folding",
  "opening",
  "window",
  "windowSliding",
  "windowRound",
] as const;

export type OpeningKind = (typeof OPENING_KINDS)[number];

const OPENING_KIND_SET: ReadonlySet<string> = new Set<string>(OPENING_KINDS);

export const isOpeningKind = (v: unknown): v is OpeningKind =>
  typeof v === "string" && OPENING_KIND_SET.has(v);

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

/**
 * 外部領域（ワイヤー 8 枚目「ペイント／直線・矩形・曲線・**外部領域**」）。
 *
 * **仕様に説明が無い。** 語が 1 つ並んでいるだけだが、すぐ上に
 * 「※COOHOMの内容を踏襲」と書いてあるので、そちらの External Area に
 * 合わせた——中庭・テラスなど、**既存の部屋の外側**にある、
 * **天井も壁も無い独立したスラブ**。
 *
 * **部屋として扱う。** COOHOM が「本質的に、外部領域は部屋属性を持つ部屋
 * として扱われる」と書いているとおり、`detectRooms` が壁から作る部屋と
 * 並べて返す。名前も仕上げも `RoomLabel` が受け持つ——**名前の付け方を
 * 2 つにしない**ため、壁で囲まれた部屋とまったく同じ道を通る。
 *
 * **壁を持たない。** だから `Room.wallIds` が空になり、壁面積も開口も出ない。
 * `Room.levelId` を足したのはこのため（以前は `wallIds[0]` から引いていた）。
 */
export interface ExteriorArea {
  id: Id;
  /** 閉じた輪郭。反時計回り。ワールド座標 */
  outline: Vec[];
  layerId: LayerId;
  levelId: Id;
  attrs: Attrs;
}

export interface Scene {
  nodes: Record<Id, Node>;
  walls: Record<Id, Wall>;
  openings: Record<Id, Opening>;
  roomLabels: Record<Id, RoomLabel>;
  /** 間取りの意味を持たない汎用図形（線・円弧・円・ポリライン・文字・点） */
  shapes: Record<Id, Shape>;
  /**
   * 外部領域（中庭・テラス）。**壁を持たない床の範囲**で、部屋として数える。
   * 名前と仕上げは `roomLabels` が受け持つ（壁で囲まれた部屋と同じ道）
   */
  areas: Record<Id, ExteriorArea>;
  /** 構造物（柱・梁・階段・スロープ・吹抜）。壁グラフには参加しない */
  fixtures: Record<Id, Fixture>;
  /** 距離計測。図面ではなく打ち合わせの道具なので、紙には出さない */
  measurements: Record<Id, Measurement>;
  /** 画層。DXF の LAYER テーブルに対応する */
  layers: Record<LayerId, Layer>;
  /**
   * 図面ビュー。**画層ではなく紙空間のビューポート**で、画層の見え方と
   * 縮尺の組を覚えている。切り替えると `layers` と `standard.scale` に当たる
   */
  views: Record<Id, DrawingView>;
  /** 作業中のビュー */
  activeViewId: Id;
  /** 線群・尺度・文字高さなどの製図規格。図面の属性なのでシーンと一緒に保存する */
  standard: DrawingStandard;
  /** 用紙枠と表題欄。これも図面の属性 */
  sheet: Sheet;
  /** ブロック定義。標準のものは起動時に入る */
  blocks: Record<Id, BlockDef>;
  /** ブロックの挿入 */
  instances: Record<Id, BlockInstance>;
  /**
   * シンボル。壁と建具を含められる挿せるひとまとまり。
   * **挿入は実体への展開（スタンプ）**なので、入れ子の座標系は作らない
   */
  assemblies: Record<Id, Assembly>;
  /** シンボルを置いた箇所。押し直すときに据え付けを戻すために持つ */
  stamps: Record<Id, Stamp>;
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
    areas: {},
    fixtures: {},
    measurements: {},
    layers: defaultLayers(),
    views: initialViews(jisStandard().scale),
    activeViewId: DEFAULT_VIEW_ID,
    standard: jisStandard(),
    sheet: defaultSheet(),
    blocks: builtinBlocks(),
    instances: {},
    assemblies: {},
    stamps: {},
    constraints: {},
    levels: defaultLevels(),
    activeLevelId: DEFAULT_LEVEL_ID,
  };
}

/** エンティティの種類から既定の画層を引く */
export const DEFAULT_LAYER_FOR: Record<Exclude<EntityType, "node">, LayerId> = {
  wall: LAYER_IDS.wall,
  opening: LAYER_IDS.opening,
  blockInstance: LAYER_IDS.furniture,
  roomLabel: LAYER_IDS.roomName,
  shape: LAYER_IDS.shape,
  fixture: LAYER_IDS.wall,
  area: LAYER_IDS.roomName,
  measurement: LAYER_IDS.draft,
};

export type EntityType =
  | "node"
  | "wall"
  | "opening"
  | "blockInstance"
  | "roomLabel"
  | "shape"
  | "fixture"
  | "area"
  | "measurement";

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
  /**
   * どの階か。
   *
   * **以前は `scene.walls[room.wallIds[0]].levelId` と引いていた。**
   * 壁を持つ部屋では同じ値になるが、**壁を持たない領域**（外部領域）では
   * 引く先が無く、作業中の階に落ちていた——2 階のテラスが 1 階の高さに出る。
   * 部屋が自分で持てば、その穴が塞がる。
   */
  levelId: Id;
  /**
   * 屋外か（外部領域から来たか）。
   *
   * **床面積の合計に足すかどうかは実務の規約**なので、ここでは混ぜずに
   * 札だけ立てる。積算は屋内と屋外を別に並べ、足し方は拾う側が決める
   * （[questions.md](../../docs/questions.md) の 32）。
   */
  outdoor: boolean;
  name: string | null;
  labelId: Id | null;
}

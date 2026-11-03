import type { Attrs } from './attrs.ts';
import { add, rotate, signedArea, vec, type Vec } from './geometry.ts';
import type { Id } from './id.ts';
import { LAYER_IDS, type LayerId } from './layer.ts';
import type { Level } from './level.ts';
import type { Primitive } from './primitive.ts';
import type { Segment } from './shape.ts';
import type { SnapKind } from './snap.ts';
import { ALL_USES, type Use } from './use.ts';

/**
 * 構造物。柱・梁・階段・スロープ・吹抜のように、**平面の footprint と
 * 鉛直方向の範囲を持つ置きもの**。
 *
 * **なぜブロックではないのか。** `BlockDef` は DXF の `INSERT` に 1:1 で
 * 対応する図形の束で、平面の大きさ (w × h) しか持たない。3D の高さは
 * `BLOCK_HEIGHTS` という**定義 id を引く表**で外から補っていて、
 * ユーザーが作ったブロックは一律 700mm になる。柱の高さが階高に追従せず、
 * 梁が天井から下がらず、階段が段にならない。
 *
 * **なぜ `Shape` ではないのか。** `Shape` は「間取りの意味を持たない汎用図形」で、
 * 高さを持たず 3D に出ない。柱は積算の対象であり、面積を食い、3D に立つ。
 *
 * **なぜ `Wall` ではないのか。** 壁はノードグラフに参加して部屋を仕切る。
 * 柱は部屋を仕切らない（部屋の中に立つ）。壁グラフに入れると部屋検出が壊れる。
 *
 * 種別ごとの違いは `FIXTURE_SPECS` の 1 行に閉じる。
 * `Record<FixtureKind, …>` なので、種別を足して書き忘れれば型検査が止まる。
 */
export const FIXTURE_KINDS = [
  'column', 'roundColumn', 'beam',
  'stair', 'stairU', 'stairL', 'stairWinder',
  'slope', 'void', 'skylight',
  // 汎用ソリッド（ワイヤー 5 枚目の「基本形状の挿入」）。
  // **柱と円柱の一般化**で、新しい描画の仕組みは要らない
  'box', 'prism', 'cylinder', 'cylinderH', 'cone', 'sphere', 'dome',
  // 押し出し。**パレットには出ない**——閉じた図形から起こすものなので、
  // 置き方が他と違う（`FixtureFamily` の `derived`）
  'extrusion',
] as const;

export type FixtureKind = (typeof FIXTURE_KINDS)[number];

/**
 * 系統。**出し分けにだけ使う札。**
 *
 * `structure` は建築の躯体（柱・梁・階段・吹抜）で、通常モードのパーツ一覧に並ぶ。
 * `solid` はプロモードの汎用ソリッド（直方体・円筒・球…）で、
 * 「ソリッド」ツールの「種類」欄にだけ並ぶ。
 * `derived` は**他のものから起こす**もの（押し出し）で、どちらにも並ばない——
 * クリックして置くものではないので、置く道具の「種類」に出すと嘘になる。
 *
 * **図面の中身は 1 つも変わらない。** 平面の記号・3D・ピック・積算・JSON・DXF は
 * どちらの系統も同じ道を通る。モードの判断を `core/` に持ち込まないために、
 * 「プロ専用か」ではなく「何の仲間か」で書いてある。
 */
export type FixtureFamily = 'structure' | 'solid' | 'derived';

const FIXTURE_KIND_SET: ReadonlySet<string> = new Set<string>(FIXTURE_KINDS);

export const isFixtureKind = (v: unknown): v is FixtureKind =>
  typeof v === 'string' && FIXTURE_KIND_SET.has(v);

export interface Fixture {
  id: Id;
  kind: FixtureKind;
  /** footprint の中心 */
  x: number;
  y: number;
  /** z 軸まわりの回転（ラジアン） */
  angle: number;
  /** 平面の大きさ (mm)。円柱は `w` を直径に使い `h` を見ない */
  size: { w: number; h: number };
  /**
   * 自前の平面の輪郭。ローカル座標（中心が原点）で反時計回り。null なら種別の既定。
   *
   * **押し出しのために足した。** `FixtureSpec.localOutline` は `{w, h}` しか
   * 受け取らないので、任意の形を置く口が無かった。種別を 1 つ増やすより、
   * 「既定の輪郭を上書きできる」ほうが押し出し・プッシュ/プル・将来の編集に効く。
   *
   * **`fixtureFingerprint` に必ず入れること。** 入れ忘れると、輪郭を変えても
   * 3D が作り直されない（指紋が同じなのでキャッシュが効き続ける）。
   */
  outline: Vec[] | null;
  /**
   * 床からの下端 (mm)。null なら種別の既定。
   *
   * 梁が「天井から下がる」のはここで表す。階高が変われば既定も追従する。
   */
  base: number | null;
  /** 立ち上がり (mm)。null なら種別の既定（柱と吹抜は階高） */
  height: number | null;
  /** 記号の中に書く文字。吹抜 / PS / 煙道 はこれで書き分ける */
  label: string;
  layerId: LayerId;
  levelId: Id;
  attrs: Attrs;
}

export interface FixtureSpec {
  label: string;
  defaultLayer: LayerId;
  defaultSize: { w: number; h: number };
  /** 既定の文字。空なら何も書かない */
  defaultLabel: string;
  /** 既定の下端。階高に依るものがあるので階を受け取る */
  defaultBase(level: Level): number;
  /** 既定の立ち上がり。同上 */
  defaultHeight(level: Level): number;
  /** 平面の輪郭。ローカル座標（中心が原点）で反時計回り */
  localOutline(size: { w: number; h: number }): Vec[];
  /** 輪郭の内側に重ねる記号。ワールド座標で返す */
  glyph(f: Fixture): Primitive[];
  /**
   * 3D に立体として出るか。
   *
   * 吹抜・PS・煙道は**穴**なので false。床を抜くのはまだ出来ていないので、
   * 3D には何も出ない（[docs/host.md] の「まだ無いもの」に書いてある）。
   */
  solid: boolean;
  /**
   * 床に開いた穴か。**部屋の床面積から引かれる。**
   *
   * `solid` とは別の札にしてある。吹抜は立体にならず、かつ床を抜く。
   * 天窓は立体にならないが、**抜くのは屋根**で床ではない。
   * 1 つの札で兼ねていたときは、天窓を置くと床面積が減った。
   */
  floorHole: boolean;
  /** 輪郭を塗るか。柱は塗る（JIS の柱は塗りつぶし） */
  filled: boolean;
  /** ピックの優先度。小さいほど先に拾う */
  pickPriority: number;
  /**
   * どの物件用途でよく使うか（ワイヤー 8 枚目のタグ）。
   * パレットの絞り込みにだけ使う。図面の中身には出ない。
   */
  uses: readonly Use[];
  /** 建築の躯体か、汎用のソリッドか。どの道具から出すかだけを決める */
  family: FixtureFamily;
}

/** 円柱の輪郭を折れ線で近似するときの分割数 */
const ROUND_SEGMENTS = 32;

const rect = (size: { w: number; h: number }): Vec[] => [
  vec(-size.w / 2, -size.h / 2),
  vec(size.w / 2, -size.h / 2),
  vec(size.w / 2, size.h / 2),
  vec(-size.w / 2, size.h / 2),
];

const circle = (size: { w: number; h: number }): Vec[] => {
  const r = size.w / 2;
  const out: Vec[] = [];
  for (let i = 0; i < ROUND_SEGMENTS; i++) {
    const a = (i / ROUND_SEGMENTS) * Math.PI * 2;
    out.push(vec(Math.cos(a) * r, Math.sin(a) * r));
  }
  return out;
};

/** 三角柱の底面。底辺が幅、頂点が奥側の中央。反時計回り */
const triangle = (size: { w: number; h: number }): Vec[] => [
  vec(-size.w / 2, -size.h / 2),
  vec(size.w / 2, -size.h / 2),
  vec(0, size.h / 2),
];

/**
 * L 形の外形。下の走り（左脚）を上がって、上の走り（上辺）へ曲がる。
 * 脚の幅は短いほうの辺の半分。
 */
const lOutline = (size: { w: number; h: number }): Vec[] => {
  const hw = size.w / 2;
  const hh = size.h / 2;
  const leg = Math.min(size.w, size.h) / 2;
  return [
    vec(-hw, -hh), vec(-hw + leg, -hh), vec(-hw + leg, hh - leg),
    vec(hw, hh - leg), vec(hw, hh), vec(-hw, hh),
  ];
};

/** 中を斜めに横切る 2 本。JIS の吹抜・PS の表し方 */
function crossGlyph(f: Fixture): Primitive[] {
  const p = outline(f);
  if (p.length < 4) return [];
  const segments: Segment[] = [
    { a: p[0], b: p[2] },
    { a: p[1], b: p[3] },
  ];
  return [{ kind: 'segments', segments }];
}

/**
 * 段板と上り勾配線。**形は `stairTreads` 1 箇所から引く。**
 *
 * 上り勾配線は**段鼻の中点**をつないだ折れ線で描く。両端だけは踏面の重心。
 * まっすぐな階段では真ん中を通る 1 本になり、コの字や回り段では
 * **実際に歩く道筋**になる——向きを種別ごとに書き分けずに済む。
 *
 * 重心だけでつなぐと、コの字の踊り場の重心が左右の真ん中に来るので、
 * 勾配線が踊り場で高く尖る。段鼻の中点なら、踊り場でも流れの中心を通る。
 */
function stepGlyph(f: Fixture): Primitive[] {
  if (!isStairKind(f.kind)) return [];
  const { treads, guides } = stairTreads(f.kind, f.size);
  const at = (p: Vec): Vec => toWorld(f, p);
  const segments: Segment[] = [];
  for (const t of treads) if (t.riser) segments.push({ a: at(t.riser[0]), b: at(t.riser[1]) });
  for (const g of guides) segments.push({ a: at(g[0]), b: at(g[1]) });

  const path = [
    at(centroid(treads[0].poly)),
    ...treads.flatMap((t) => (t.riser ? [at(mid(t.riser[0], t.riser[1]))] : [])),
    at(centroid(treads[treads.length - 1].poly)),
  ];
  for (let i = 1; i < path.length; i++) segments.push({ a: path[i - 1], b: path[i] });

  // 矢印の頭。最後の 1 歩の向きに開く
  const tip = path[path.length - 1];
  const prev = path[path.length - 2] ?? path[0];
  const dir = Math.atan2(tip.y - prev.y, tip.x - prev.x);
  const wing = Math.min(f.size.w, f.size.h) * 0.12;
  for (const spread of [Math.PI * 0.8, -Math.PI * 0.8]) {
    segments.push({
      a: tip,
      b: vec(tip.x + Math.cos(dir + spread) * wing, tip.y + Math.sin(dir + spread) * wing),
    });
  }
  return [{ kind: 'segments', segments }];
}

/** 線分の中点 */
const mid = (a: Vec, b: Vec): Vec => vec((a.x + b.x) / 2, (a.y + b.y) / 2);

/** 多角形の重心。段の真ん中を拾うだけなので頂点の平均で足りる */
const centroid = (poly: Vec[]): Vec => ({
  x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
  y: poly.reduce((s, p) => s + p.y, 0) / poly.length,
});

/** 段 1 つの奥行 (mm)。蹴上 180 / 踏面 250 の普通の階段 */
export const STEP_DEPTH = 250;

/** 段 1 つ。踏面の輪郭と、平面に引く段鼻の線 */
export interface Tread {
  /** 踏面の輪郭。ローカル座標（中心が原点）、反時計回り */
  poly: Vec[];
  /** 段鼻の線。1 段目は外形と重なるので持たない */
  riser: [Vec, Vec] | null;
}

export interface StairPlan {
  /** 下から上へ並ぶ段 */
  treads: Tread[];
  /** 段鼻ではない補助線。コの字の 2 つの流れの間の仕切りなど */
  guides: [Vec, Vec][];
}

export const STAIR_KINDS = ['stair', 'stairU', 'stairL', 'stairWinder'] as const;

export type StairKind = (typeof STAIR_KINDS)[number];

const STAIR_KIND_SET: ReadonlySet<string> = new Set<string>(STAIR_KINDS);

export const isStairKind = (kind: FixtureKind): kind is StairKind => STAIR_KIND_SET.has(kind);

/** 走り 1 本の段数。段が 1 つしかない階段は階段に見えないので 2 を下限にする */
const treadCount = (run: number): number => Math.max(2, Math.round(run / STEP_DEPTH));

/** 反時計回りの矩形。向きを呼ぶ側に気にさせない */
const ccwRect = (xa: number, xb: number, ya: number, yb: number): Vec[] => {
  const [x0, x1] = xa < xb ? [xa, xb] : [xb, xa];
  const [y0, y1] = ya < yb ? [ya, yb] : [yb, ya];
  return [vec(x0, y0), vec(x1, y0), vec(x1, y1), vec(x0, y1)];
};

/**
 * まっすぐな走り。`y0` から `y1` へ進む（降りる向きもある）。
 * 1 段目の段鼻は、呼ぶ側が「走りの始まりかどうか」で決める。
 */
function runY(x0: number, x1: number, y0: number, y1: number, first: boolean): Tread[] {
  const n = treadCount(Math.abs(y1 - y0));
  const out: Tread[] = [];
  for (let i = 0; i < n; i++) {
    const a = y0 + ((y1 - y0) * i) / n;
    const b = y0 + ((y1 - y0) * (i + 1)) / n;
    out.push({
      poly: ccwRect(x0, x1, a, b),
      riser: first && i === 0 ? null : [vec(x0, a), vec(x1, a)],
    });
  }
  return out;
}

/** まっすぐな走り。`x0` から `x1` へ進む */
function runX(y0: number, y1: number, x0: number, x1: number, first: boolean): Tread[] {
  const n = treadCount(Math.abs(x1 - x0));
  const out: Tread[] = [];
  for (let i = 0; i < n; i++) {
    const a = x0 + ((x1 - x0) * i) / n;
    const b = x0 + ((x1 - x0) * (i + 1)) / n;
    out.push({
      poly: ccwRect(a, b, y0, y1),
      riser: first && i === 0 ? null : [vec(a, y0), vec(a, y1)],
    });
  }
  return out;
}

/**
 * 回り段。角の正方形を、内側の角を軸に 3 枚へ扇形に割る。
 *
 * `pivot` は内角、`corner` は外角。平面でも 3D でも同じ 3 枚になる。
 */
function winderTreads(pivot: Vec, corner: Vec, leg: number): Tread[] {
  // 内角から外側の 2 辺へ向かう 2 方向。その間を 3 等分する
  const a0 = Math.atan2(0, Math.sign(corner.x - pivot.x));
  const a1 = Math.atan2(Math.sign(corner.y - pivot.y), 0);
  const step = (a1 - a0) / 3;
  const hit = (angle: number): { p: Vec; onX: boolean } => {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const tx = Math.abs(dx) < 1e-9 ? Infinity : leg / Math.abs(dx);
    const ty = Math.abs(dy) < 1e-9 ? Infinity : leg / Math.abs(dy);
    const t = Math.min(tx, ty);
    return { p: vec(pivot.x + dx * t, pivot.y + dy * t), onX: tx <= ty };
  };
  const rays = [0, 1, 2, 3].map((i) => hit(a0 + step * i));
  const out: Tread[] = [];
  for (let i = 0; i < 3; i++) {
    const poly = [pivot, rays[i].p];
    // 2 本のレイが別の辺に当たっているなら、間に外角が挟まる
    if (rays[i].onX !== rays[i + 1].onX) poly.push(corner);
    poly.push(rays[i + 1].p);
    out.push({ poly: ccw(poly), riser: [pivot, rays[i].p] });
  }
  return out;
}

/** 反時計回りに揃える。踏面は 3D の押し出しが向きを前提にしている */
const ccw = (poly: Vec[]): Vec[] => (signedArea(poly) < 0 ? [...poly].reverse() : poly);

/**
 * 階段の段。**平面の段板と 3D の段がここ 1 箇所から出る。**
 *
 * 以前は段数の式が平面と 3D に 1 つずつあり、片方を直すと図と立体がずれた。
 * 種別を 3 つ足すにあたって、形そのものを 1 箇所に寄せた。
 */
export function stairTreads(kind: StairKind, size: { w: number; h: number }): StairPlan {
  const hw = size.w / 2;
  const hh = size.h / 2;

  if (kind === 'stair') {
    return { treads: runY(-hw, hw, -hh, hh, true), guides: [] };
  }

  if (kind === 'stairU') {
    // **左右の流れの間に空間を作らない**（奥谷さんの指摘）。
    // 踊り場の奥行は流れ 1 本の幅と同じで、180 度まわるのにちょうど足りる
    const landing = hw;
    const turn = hh - landing;
    const up = runY(-hw, 0, -hh, turn, true);
    const flat: Tread = { poly: ccwRect(-hw, hw, turn, hh), riser: [vec(-hw, turn), vec(0, turn)] };
    const down = runY(0, hw, turn, -hh, false);
    return {
      treads: [...up, flat, ...down],
      guides: [[vec(0, -hh), vec(0, turn)]],
    };
  }

  // L 字と回り段は同じ L 形。角を踊り場 1 枚にするか、3 枚の回り段にするかが違う
  const leg = Math.min(size.w, size.h) / 2;
  const corner = vec(-hw, hh);
  const pivot = vec(-hw + leg, hh - leg);
  const up = runY(-hw, -hw + leg, -hh, hh - leg, true);
  const turn: Tread[] = kind === 'stairWinder'
    ? winderTreads(pivot, corner, leg)
    : [{ poly: ccwRect(-hw, pivot.x, pivot.y, hh), riser: [vec(-hw, pivot.y), vec(pivot.x, pivot.y)] }];
  const across = runX(hh - leg, hh, -hw + leg, hw, false);
  return { treads: [...up, ...turn, ...across], guides: [] };
}

/** 梁のせい (mm)。天井からこれだけ下がる */
const BEAM_DEPTH = 400;

export const FIXTURE_SPECS: Record<FixtureKind, FixtureSpec> = {
  column: {
    label: '角柱',
    defaultLayer: LAYER_IDS.wall,
    defaultSize: { w: 300, h: 300 },
    defaultLabel: '',
    defaultBase: () => 0,
    defaultHeight: (level) => level.wallHeight,
    localOutline: rect,
    glyph: () => [],
    solid: true,
    floorHole: false,
    filled: true,
    pickPriority: 2,
    family: 'structure',
    uses: ALL_USES,
  },
  roundColumn: {
    label: '円柱',
    defaultLayer: LAYER_IDS.wall,
    defaultSize: { w: 300, h: 300 },
    defaultLabel: '',
    defaultBase: () => 0,
    defaultHeight: (level) => level.wallHeight,
    localOutline: circle,
    glyph: () => [],
    solid: true,
    floorHole: false,
    filled: true,
    pickPriority: 2,
    family: 'structure',
    uses: ALL_USES,
  },
  beam: {
    label: '梁',
    defaultLayer: LAYER_IDS.wall,
    defaultSize: { w: 300, h: 3000 },
    defaultLabel: '',
    // **天井から下がる。** 階高が変われば既定も追従する
    defaultBase: (level) => Math.max(0, level.wallHeight - BEAM_DEPTH),
    defaultHeight: () => BEAM_DEPTH,
    localOutline: rect,
    glyph: () => [],
    solid: true,
    floorHole: false,
    filled: false,
    pickPriority: 3,
    family: 'structure',
    uses: ALL_USES,
  },
  stair: {
    label: '階段',
    defaultLayer: LAYER_IDS.furniture,
    defaultSize: { w: 900, h: 2700 },
    defaultLabel: '',
    defaultBase: () => 0,
    defaultHeight: (level) => level.wallHeight,
    localOutline: rect,
    glyph: stepGlyph,
    solid: true,
    floorHole: false,
    filled: false,
    pickPriority: 4,
    family: 'structure',
    uses: ['住'],
  },
  /** コの字階段（COOHOM の U 字型階段）。**左右の流れの間に空間を作らない** */
  stairU: {
    label: '階段(コの字)',
    defaultLayer: LAYER_IDS.furniture,
    defaultSize: { w: 1800, h: 2700 },
    defaultLabel: '',
    defaultBase: () => 0,
    defaultHeight: (level) => level.wallHeight,
    localOutline: rect,
    glyph: stepGlyph,
    solid: true,
    floorHole: false,
    filled: false,
    pickPriority: 4,
    family: 'structure',
    uses: ['住'],
  },
  /** L 字階段。角は踊り場 1 枚 */
  stairL: {
    label: '階段(L字)',
    defaultLayer: LAYER_IDS.furniture,
    defaultSize: { w: 2400, h: 2400 },
    defaultLabel: '',
    defaultBase: () => 0,
    defaultHeight: (level) => level.wallHeight,
    localOutline: lOutline,
    glyph: stepGlyph,
    solid: true,
    floorHole: false,
    filled: false,
    pickPriority: 4,
    family: 'structure',
    uses: ['住'],
  },
  /** 回り段。L 字の角を 3 枚の扇形に割る */
  stairWinder: {
    label: '階段(回り段)',
    defaultLayer: LAYER_IDS.furniture,
    defaultSize: { w: 2400, h: 2400 },
    defaultLabel: '',
    defaultBase: () => 0,
    defaultHeight: (level) => level.wallHeight,
    localOutline: lOutline,
    glyph: stepGlyph,
    solid: true,
    floorHole: false,
    filled: false,
    pickPriority: 4,
    family: 'structure',
    uses: ['住'],
  },
  slope: {
    label: 'スロープ',
    defaultLayer: LAYER_IDS.furniture,
    defaultSize: { w: 1200, h: 3000 },
    defaultLabel: '',
    defaultBase: () => 0,
    defaultHeight: () => 150,
    localOutline: rect,
    glyph: () => [],
    solid: true,
    floorHole: false,
    filled: false,
    pickPriority: 4,
    family: 'structure',
    uses: ALL_USES,
  },
  void: {
    label: '吹抜',
    defaultLayer: LAYER_IDS.shape,
    defaultSize: { w: 2000, h: 2000 },
    defaultLabel: '吹抜',
    defaultBase: () => 0,
    defaultHeight: (level) => level.wallHeight,
    localOutline: rect,
    glyph: crossGlyph,
    // **穴なので立てない。** 3D で床を抜くのはまだ出来ていない
    solid: false,
    floorHole: true,
    filled: false,
    pickPriority: 5,
    // 吹抜＜住＞・PS＜住オ店＞・煙道＜オ店＞を 1 つの種別で兼ねるので、絞らない
    family: 'structure',
    uses: ALL_USES,
  },

  /**
   * 天窓（トップライト）。**`Opening` では表せない。**
   *
   * 開口は `wallId` を必ず持ち、鉛直な壁の上の 1 次元区間として生きている。
   * 天窓が付くのは屋根で、この図面に屋根という概念は無い。
   * 吹抜と同じ「水平面に置いて平面に記号を描き、3D では実体を作らない」形で持つ。
   *
   * **床面積は減らない**（`floorHole: false`）。**積算に開口としては出ない**——
   * 壁の数量を控除するのは `Opening` だけで、天窓は壁に穴を開けない。
   */
  skylight: {
    label: '天窓',
    defaultLayer: LAYER_IDS.shape,
    defaultSize: { w: 900, h: 900 },
    defaultLabel: '天窓',
    // 天井の高さに置く。記号は平面に出るので、高さは 3D と積算のための札
    defaultBase: (level) => level.wallHeight,
    defaultHeight: () => 100,
    localOutline: rect,
    // 吹抜と同じ対角線。**区別は中に書く文字**で、PS や煙道と同じ流儀
    glyph: crossGlyph,
    solid: false,
    floorHole: false,
    filled: false,
    pickPriority: 5,
    family: 'structure',
    uses: ['住'],
  },
  // ---- ここから汎用ソリッド（ワイヤー 5 枚目の「基本形状の挿入」）----
  //
  // **柱と円柱の一般化。** 角柱は直方体の、円柱は垂直の円筒の特例になっている。
  // 平面の輪郭・ピック・積算・JSON・DXF は構造物と同じ道を通るので、
  // ここと `FIXTURE_SOLIDS`（`render3d/fixture3d.ts`）を埋めるだけで済む。
  //
  // **傾きは持たない。** `toWorld` が z 軸まわりの 2 次元回転なので、
  // 寝かせた円筒は種別として持つ（ワイヤーも「水平」「垂直」と分けて書いている）。
  // 任意の傾きが要るかは確認事項 13。
  //
  // **塗らない。** 柱を塗るのは JIS の決まりで、汎用の立体にその理由は無い。
  // 塗ると平面で柱と見分けが付かなくなる。

  box: {
    label: '直方体',
    defaultLayer: LAYER_IDS.shape,
    defaultSize: { w: 600, h: 600 },
    defaultLabel: '',
    defaultBase: () => 0,
    defaultHeight: () => 600,
    localOutline: rect,
    glyph: () => [],
    solid: true,
    floorHole: false,
    filled: false,
    pickPriority: 4,
    family: 'solid',
    uses: ALL_USES,
  },
  prism: {
    label: '三角柱',
    defaultLayer: LAYER_IDS.shape,
    defaultSize: { w: 600, h: 600 },
    defaultLabel: '',
    defaultBase: () => 0,
    defaultHeight: () => 600,
    localOutline: triangle,
    glyph: () => [],
    solid: true,
    floorHole: false,
    filled: false,
    pickPriority: 4,
    family: 'solid',
    uses: ALL_USES,
  },
  /** 垂直の円筒。`w` が直径で `h` は見ない（円柱と同じ） */
  cylinder: {
    label: '円筒(垂直)',
    defaultLayer: LAYER_IDS.shape,
    defaultSize: { w: 600, h: 600 },
    defaultLabel: '',
    defaultBase: () => 0,
    defaultHeight: () => 600,
    localOutline: circle,
    glyph: () => [],
    solid: true,
    floorHole: false,
    filled: false,
    pickPriority: 4,
    family: 'solid',
    uses: ALL_USES,
  },
  /**
   * 寝かせた円筒。**平面では矩形に見える**——真上から見た寝た筒は矩形だから。
   * `w` が直径、`h` が長さ、高さ（`height`）が断面の縦の径。
   */
  cylinderH: {
    label: '円筒(水平)',
    defaultLayer: LAYER_IDS.shape,
    defaultSize: { w: 600, h: 1200 },
    defaultLabel: '',
    defaultBase: () => 0,
    defaultHeight: () => 600,
    localOutline: rect,
    glyph: () => [],
    solid: true,
    floorHole: false,
    filled: false,
    pickPriority: 4,
    family: 'solid',
    uses: ALL_USES,
  },
  cone: {
    label: '円錐',
    defaultLayer: LAYER_IDS.shape,
    defaultSize: { w: 600, h: 600 },
    defaultLabel: '',
    defaultBase: () => 0,
    defaultHeight: () => 600,
    localOutline: circle,
    glyph: () => [],
    solid: true,
    floorHole: false,
    filled: false,
    pickPriority: 4,
    family: 'solid',
    uses: ALL_USES,
  },
  /** 球。既定では高さ＝直径だが、高さを変えれば縦に伸びた回転楕円体になる */
  sphere: {
    label: '球',
    defaultLayer: LAYER_IDS.shape,
    defaultSize: { w: 600, h: 600 },
    defaultLabel: '',
    defaultBase: () => 0,
    defaultHeight: () => 600,
    localOutline: circle,
    glyph: () => [],
    solid: true,
    floorHole: false,
    filled: false,
    pickPriority: 4,
    family: 'solid',
    uses: ALL_USES,
  },
  /**
   * 押し出し。**閉じた図形から起こす。形は `Fixture.outline` が持つ。**
   *
   * `localOutline` は輪郭を持たない個体（壊れたファイルから来たものなど）の
   * ための保険で、普段は使われない。
   */
  extrusion: {
    label: '押し出し',
    defaultLayer: LAYER_IDS.shape,
    defaultSize: { w: 1000, h: 1000 },
    defaultLabel: '',
    defaultBase: () => 0,
    defaultHeight: () => 1000,
    localOutline: rect,
    glyph: () => [],
    solid: true,
    floorHole: false,
    filled: false,
    pickPriority: 4,
    family: 'derived',
    uses: ALL_USES,
  },

  /** 半球（ドーム）。底が平らで、既定の高さは半径 */
  dome: {
    label: '半球',
    defaultLayer: LAYER_IDS.shape,
    defaultSize: { w: 600, h: 600 },
    defaultLabel: '',
    defaultBase: () => 0,
    defaultHeight: () => 300,
    localOutline: circle,
    glyph: () => [],
    solid: true,
    floorHole: false,
    filled: false,
    pickPriority: 4,
    family: 'solid',
    uses: ALL_USES,
  },
};

/**
 * その系統の種別だけ並べる。パレットと「種類」欄が読む。
 *
 * **`FIXTURE_KINDS` の順をそのまま保つ。** 表に足した順が画面の順になる。
 */
export const fixtureKindsOf = (family: FixtureFamily): FixtureKind[] =>
  FIXTURE_KINDS.filter((k) => FIXTURE_SPECS[k].family === family);

export const specOf = (f: Fixture): FixtureSpec => FIXTURE_SPECS[f.kind];

/**
 * 平面の輪郭が円か。**直径 1 つで形が決まる**ので、幅と奥行を分けて持たない。
 *
 * 札を 1 つ増やさず、輪郭の関数そのものを見る。種別を足したときに
 * 書き忘れようがない——`circle` を渡したかどうかが、そのまま答えになる。
 */
export const isRoundFixture = (kind: FixtureKind): boolean =>
  FIXTURE_SPECS[kind].localOutline === circle;

/**
 * 平面の輪郭が矩形か。**押し引きで側面を動かせるのはこれだけ。**
 *
 * 矩形なら「どの面を押したか」が `size.w` / `size.h` のどちらかに素直に落ちる。
 * 円・三角・L 形・自前の輪郭では、1 つの面を動かした結果が
 * `{w, h}` で表せない（辺を 1 本だけずらした形になる）。
 */
export const isBoxFixture = (kind: FixtureKind): boolean =>
  FIXTURE_SPECS[kind].localOutline === rect;

/** ローカル座標をワールドへ */
export function toWorld(f: Fixture, p: Vec): Vec {
  return add(rotate(p, f.angle), vec(f.x, f.y));
}

/** ローカルの輪郭。自前の輪郭があればそちら、無ければ種別の既定 */
export const localOutline = (f: Fixture): Vec[] =>
  f.outline ?? specOf(f).localOutline(f.size);

/** ワールドの輪郭。反時計回り */
export function outline(f: Fixture): Vec[] {
  return localOutline(f).map((p) => toWorld(f, p));
}

/** 当たり判定用の折れ線 */
export function outlineSegments(f: Fixture): Segment[] {
  const p = outline(f);
  return p.map((a, i) => ({ a, b: p[(i + 1) % p.length] }));
}

/** 下端と上端 (mm)。階の床を基準にした絶対の z */
export function verticalRange(f: Fixture, level: Level): { z0: number; z1: number } {
  const spec = specOf(f);
  const base = f.base ?? spec.defaultBase(level);
  const height = f.height ?? spec.defaultHeight(level);
  return { z0: level.floorZ + base, z1: level.floorZ + base + height };
}

/** これより頂点が多い輪郭はスナップ点を出さない。中心だけになる */
const MAX_SNAP_VERTICES = 32;

export function fixtureSnapPoints(f: Fixture): { point: Vec; kind: SnapKind }[] {
  const out: { point: Vec; kind: SnapKind }[] = [
    { point: vec(f.x, f.y), kind: 'center' },
  ];
  // 円の近似多角形の頂点を 32 個ぜんぶ出すと、スナップが重くなるだけで役に立たない。
  // **押し出した形も同じ**——自由曲線から起こすと頂点が 100 個を超える
  const poly = localOutline(f);
  if (!isRoundFixture(f.kind) && poly.length <= MAX_SNAP_VERTICES) {
    for (const p of outline(f)) out.push({ point: p, kind: 'node' });
  }
  return out;
}

/** 平面に出すもの。輪郭 + 種別ごとの記号 + 文字 */
export function fixturePrimitives(f: Fixture, textPaperMm: number): Primitive[] {
  const spec = specOf(f);
  const out: Primitive[] = [
    { kind: 'polygon', points: outline(f), fill: spec.filled ? 'layer' : 'none' },
    ...spec.glyph(f),
  ];
  if (f.label.length > 0) {
    out.push({
      kind: 'text',
      text: f.label,
      at: vec(f.x, f.y),
      paperMm: textPaperMm,
      angle: f.angle,
      align: 'center',
    });
  }
  return out;
}

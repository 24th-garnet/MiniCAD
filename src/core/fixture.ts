import type { Attrs } from './attrs.ts';
import { add, rotate, vec, type Vec } from './geometry.ts';
import type { Id } from './id.ts';
import { LAYER_IDS, type LayerId } from './layer.ts';
import type { Level } from './level.ts';
import type { Primitive } from './primitive.ts';
import type { Segment } from './shape.ts';
import type { SnapKind } from './snap.ts';

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
export const FIXTURE_KINDS = ['column', 'roundColumn', 'beam', 'stair', 'slope', 'void'] as const;

export type FixtureKind = (typeof FIXTURE_KINDS)[number];

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
  /** 輪郭を塗るか。柱は塗る（JIS の柱は塗りつぶし） */
  filled: boolean;
  /** ピックの優先度。小さいほど先に拾う */
  pickPriority: number;
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

/** 段板。長手方向に等間隔で引く */
function stepGlyph(f: Fixture): Primitive[] {
  const steps = Math.max(2, Math.round(f.size.h / STEP_DEPTH));
  const segments: Segment[] = [];
  for (let i = 1; i < steps; i++) {
    const y = -f.size.h / 2 + (f.size.h * i) / steps;
    segments.push({
      a: toWorld(f, vec(-f.size.w / 2, y)),
      b: toWorld(f, vec(f.size.w / 2, y)),
    });
  }
  // 上り方向の矢印。足元から上階へ
  const tipY = f.size.h / 2 - STEP_DEPTH * 0.4;
  const tip = toWorld(f, vec(0, tipY));
  const wing = Math.min(f.size.w, f.size.h) * 0.12;
  segments.push(
    { a: toWorld(f, vec(0, -f.size.h / 2 + STEP_DEPTH * 0.4)), b: tip },
    { a: tip, b: toWorld(f, vec(-wing, tipY - wing)) },
    { a: tip, b: toWorld(f, vec(wing, tipY - wing)) },
  );
  return [{ kind: 'segments', segments }];
}

/** 段 1 つの奥行 (mm)。蹴上 180 / 踏面 250 の普通の階段 */
export const STEP_DEPTH = 250;

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
    filled: true,
    pickPriority: 2,
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
    filled: true,
    pickPriority: 2,
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
    filled: false,
    pickPriority: 3,
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
    filled: false,
    pickPriority: 4,
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
    filled: false,
    pickPriority: 4,
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
    // **穴なので立てない。** 床を抜くのはまだ出来ていない
    solid: false,
    filled: false,
    pickPriority: 5,
  },
};

export const specOf = (f: Fixture): FixtureSpec => FIXTURE_SPECS[f.kind];

/** ローカル座標をワールドへ */
export function toWorld(f: Fixture, p: Vec): Vec {
  return add(rotate(p, f.angle), vec(f.x, f.y));
}

/** ワールドの輪郭。反時計回り */
export function outline(f: Fixture): Vec[] {
  return specOf(f).localOutline(f.size).map((p) => toWorld(f, p));
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

export function fixtureSnapPoints(f: Fixture): { point: Vec; kind: SnapKind }[] {
  const out: { point: Vec; kind: SnapKind }[] = [
    { point: vec(f.x, f.y), kind: 'center' },
  ];
  // 円柱の近似多角形の頂点を 32 個ぜんぶ出すと、スナップが重くなるだけで役に立たない
  if (f.kind !== 'roundColumn') {
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

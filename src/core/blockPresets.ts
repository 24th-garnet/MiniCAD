import { vec, type Vec } from './geometry.ts';
import type { Id } from './id.ts';
import { LAYER_IDS } from './layer.ts';
import type { Shape } from './shapes.ts';

/**
 * id と画層を除いた図形。
 * `Omit<Shape, ...>` は共用体にそのまま掛けると各枝に分配されないので、
 * 明示的に分配してから Omit する。
 */
type ShapeBody = { [K in Shape['shape']]: Omit<Extract<Shape, { shape: K }>, 'id' | 'layerId'> }[Shape['shape']];
import type { BlockDef } from './block.ts';

/**
 * 標準ブロック。間取りでよく置くものをあらかじめ定義にしてある。
 *
 * 以前は `Furniture` という専用のエンティティで、記号は renderer の
 * `FurnitureKind` による switch で描いていた。中身を図形として持たせたことで
 * その switch が不要になり、ユーザー定義のブロックと同じ経路で描ける。
 *
 * 座標はブロックのローカル系で、基点（原点）が中心。
 */
export interface BlockPreset {
  id: string;
  name: string;
  label: string;
  w: number;
  h: number;
  /** 矩形に重ねる記号 */
  glyph?: (w: number, h: number) => ShapeBody[];
}

/** 矩形の内側を横切る線。ベッドの枕側や階段の段板に使う */
const crossBar = (w: number, h: number, t: number): ShapeBody => ({
  shape: 'line',
  a: vec(-w / 2, -h / 2 + h * t),
  b: vec(w / 2, -h / 2 + h * t),
});

const circleGlyph = (ratio: number) => (w: number, h: number): ShapeBody[] => [
  { shape: 'circle', center: vec(0, 0), radius: Math.min(w, h) * ratio },
];

export const BLOCK_PRESETS: BlockPreset[] = [
  { id: 'bed-single', name: 'FURN_BED_S', label: 'ベッドS', w: 1000, h: 1950, glyph: (w, h) => [crossBar(w, h, 0.26)] },
  { id: 'bed-double', name: 'FURN_BED_D', label: 'ベッドD', w: 1400, h: 1950, glyph: (w, h) => [crossBar(w, h, 0.26)] },
  { id: 'sofa', name: 'FURN_SOFA', label: 'ソファ', w: 1800, h: 850 },
  { id: 'dining', name: 'FURN_TABLE', label: 'ダイニング', w: 1500, h: 800 },
  { id: 'chair', name: 'FURN_CHAIR', label: '椅子', w: 450, h: 450 },
  { id: 'kitchen', name: 'FURN_KITCHEN', label: 'キッチン', w: 2550, h: 650, glyph: circleGlyph(0.22) },
  { id: 'sink', name: 'FURN_SINK', label: '洗面台', w: 750, h: 550, glyph: circleGlyph(0.32) },
  { id: 'toilet', name: 'FURN_TOILET', label: 'トイレ', w: 450, h: 750, glyph: circleGlyph(0.32) },
  { id: 'bath', name: 'FURN_BATH', label: '浴槽', w: 1600, h: 800, glyph: circleGlyph(0.32) },
  {
    id: 'stairs',
    name: 'FURN_STAIRS',
    label: '階段',
    w: 900,
    h: 2700,
    glyph: (w, h) => {
      const steps = Math.max(2, Math.round(h / 250));
      const out: ShapeBody[] = [];
      for (let i = 1; i < steps; i++) out.push(crossBar(w, h, i / steps));
      return out;
    },
  },
  { id: 'box', name: 'FURN_BOX', label: 'ボックス', w: 900, h: 600 },
];

function outlineRect(w: number, h: number): ShapeBody {
  const corners: Vec[] = [vec(-w / 2, -h / 2), vec(w / 2, -h / 2), vec(w / 2, h / 2), vec(-w / 2, h / 2)];
  return { shape: 'polyline', points: corners, closed: true };
}

export function buildPresetBlock(preset: BlockPreset): BlockDef {
  const shapes: Record<Id, Shape> = {};
  let n = 0;
  const add = (partial: ShapeBody) => {
    const id = `${preset.id}-${n++}`;
    shapes[id] = { ...partial, id, layerId: LAYER_IDS.furniture } as Shape;
  };

  add(outlineRect(preset.w, preset.h));
  for (const glyph of preset.glyph?.(preset.w, preset.h) ?? []) add(glyph);

  return {
    id: preset.id,
    name: preset.name,
    label: preset.label,
    size: { w: preset.w, h: preset.h },
    shapes,
    source: 'builtin',
  };
}

export function builtinBlocks(): Record<Id, BlockDef> {
  return Object.fromEntries(BLOCK_PRESETS.map((p) => [p.id, buildPresetBlock(p)]));
}

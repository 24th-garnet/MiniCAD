import { dist, vec, type Vec } from './geometry.ts';
import type { Id, Scene, Wall } from './types.ts';

/**
 * 幾何拘束。
 *
 * **対象はノードではなく壁**。`splitWall` は元の壁 id を前半に残し、
 * `mergeNodesAt` は壁の端点を付け替えてノードを消すので、
 * ノード id のほうが壁 id より寿命が短い。さらに `pruneOrphanNodes` は
 * `DimEnd.nodeId` を見ていないという既知の穴があり、ノード参照を増やすと
 * その穴をもう一つ作ることになる。壁参照ならどちらとも無縁で、
 * `pruneOrphanNodes` に手を入れる必要がない。
 *
 * **「一致 (coincident)」は入れない。** MiniCAD で一致は座標の関係ではなく
 * トポロジで、`findOrCreateNode` と `mergeNodesAt` がノードそのものを
 * 共有させることで実現している。拘束として持つと、ソルバが
 * 「2つのノードを同じ座標に寄せるだけで id は別のまま」にできてしまい、
 * 部屋検出（ノードの共有をたどる）が「見た目は閉じているのに部屋が無い」状態に陥る。
 * くっつけたいときは拘束ではなく `mergeNodesAt` を呼ぶ。
 */
export const CONSTRAINT_KINDS = ['horizontal', 'vertical', 'parallel', 'perpendicular', 'distance'] as const;

export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set<string>(CONSTRAINT_KINDS);

export const isConstraintKind = (v: unknown): v is ConstraintKind => typeof v === 'string' && KIND_SET.has(v);

export interface Constraint {
  id: Id;
  kind: ConstraintKind;
  /** 対象の壁。horizontal / vertical / distance は1本、parallel / perpendicular は2本 */
  walls: Id[];
  /** distance だけが mm の値を持つ。他は null */
  value: number | null;
}

/** 残差の、あるノード座標についての偏微分 */
export interface GradientTerm {
  nodeId: Id;
  dx: number;
  dy: number;
}

/**
 * 角度系の残差を長さの次元に揃えるための基準長 (mm)。
 *
 * 生の `cross(d1,d2)` / `dot(d1,d2)` は mm² 次元で、壁長 3000mm どうしなら
 * 水平拘束の残差（mm）に対して 10⁶ 倍になる。`JᵀJ` の対角が桁で揃わず、
 * ダンピング λ が片方の拘束にしか効かなくなる。
 * 単位ベクトルに正規化してからこの長さを掛けることで、全種別が mm 次元に揃う。
 */
const ANGULAR_SCALE = 1000;

/**
 * これより短い壁を含む拘束は、残差も勾配も出さない（正規化で勾配が発散するため）。
 * `ops.ts` の `NODE_MERGE_TOLERANCE` と同じ値。
 *
 * ここで import せず値を書いているのは循環参照を避けるため。
 * `ops.ts` → `constraintOps.ts` → `constraints.ts` と辿るので、
 * このモジュールが `ops.ts` を読むと初期化順の罠にはまる。
 * そのためこのファイルは `geometry.ts` と `types.ts` しか見ない。
 */
const MIN_WALL_LEN = 1;

/** 壁の両端。`ops.ts` の `wallEnds` と同じだが、循環参照を避けてここに持つ */
function endsOf(scene: Scene, wall: Wall): [Vec, Vec] | null {
  const a = scene.nodes[wall.a];
  const b = scene.nodes[wall.b];
  return a && b ? [vec(a.x, a.y), vec(b.x, b.y)] : null;
}

export interface ConstraintSpec {
  label: string;
  /** 必要な壁の本数 */
  arity: 1 | 2;
  /** 値（mm）を持つか */
  usesValue: boolean;
  /** 画面に出す記号 */
  glyph: string;
  /** 残差。退化していたら null（その行を飛ばす） */
  residual(scene: Scene, c: Constraint): number | null;
  /** 関与する各ノード座標についての偏微分。同じノードが複数回現れることがある */
  gradient(scene: Scene, c: Constraint): GradientTerm[];
  /** 追加時の初期値 */
  initialValue(scene: Scene, walls: Id[]): number | null;
  /** その選択に付けられるか。UI のボタンの出し分けにも使う */
  applicable(scene: Scene, walls: Id[]): boolean;
}

/** 壁の端点と方向。退化していたら null */
interface Leg {
  a: Id;
  b: Id;
  pa: Vec;
  pb: Vec;
  /** 単位ベクトル */
  ux: number;
  uy: number;
  len: number;
}

function leg(scene: Scene, wallId: Id | undefined): Leg | null {
  const wall = wallId ? scene.walls[wallId] : undefined;
  if (!wall) return null;
  const pair = endsOf(scene, wall);
  if (!pair) return null;
  const [pa, pb] = pair;
  const len = dist(pa, pb);
  if (!(len >= MIN_WALL_LEN)) return null;
  return { a: wall.a, b: wall.b, pa, pb, ux: (pb.x - pa.x) / len, uy: (pb.y - pa.y) / len, len };
}

const legs = (scene: Scene, c: Constraint): [Leg, Leg] | null => {
  const first = leg(scene, c.walls[0]);
  const second = leg(scene, c.walls[1]);
  return first && second ? [first, second] : null;
};

/**
 * 2本の壁に対する角度系の勾配。
 *
 * `g1` / `g2` は「単位ベクトル u / v についての偏微分」で、
 * これを `(I − u uᵀ) / |d|` に通すと元の端点座標についての偏微分になる。
 * `(I − u uᵀ) g = g − u (u·g)` なので、射影を1行で書ける。
 */
function angularGradient(x: Leg, y: Leg, gx: Vec, gy: Vec): GradientTerm[] {
  const out: GradientTerm[] = [];
  const push = (l: Leg, g: Vec) => {
    const proj = l.ux * g.x + l.uy * g.y;
    const dx = (ANGULAR_SCALE * (g.x - l.ux * proj)) / l.len;
    const dy = (ANGULAR_SCALE * (g.y - l.uy * proj)) / l.len;
    // d = pb − pa なので、pb には +、pa には − で効く
    out.push({ nodeId: l.b, dx, dy }, { nodeId: l.a, dx: -dx, dy: -dy });
  };
  push(x, gx);
  push(y, gy);
  return out;
}

/**
 * 種別ごとの仕様。
 * `Record<ConstraintKind, …>` なので、`CONSTRAINT_KINDS` に種別を足すと
 * ここだけが型エラーになる。UI のボタンもテストのケース表も自動で増える。
 */
export const CONSTRAINT_SPECS: Record<ConstraintKind, ConstraintSpec> = {
  horizontal: {
    label: '水平',
    arity: 1,
    usesValue: false,
    glyph: '=',
    residual: (scene, c) => {
      const l = leg(scene, c.walls[0]);
      return l ? l.pb.y - l.pa.y : null;
    },
    gradient: (scene, c) => {
      const l = leg(scene, c.walls[0]);
      return l ? [{ nodeId: l.b, dx: 0, dy: 1 }, { nodeId: l.a, dx: 0, dy: -1 }] : [];
    },
    initialValue: () => null,
    applicable: (scene, walls) => walls.length === 1 && !!scene.walls[walls[0]],
  },

  vertical: {
    label: '垂直',
    arity: 1,
    usesValue: false,
    glyph: '‖',
    residual: (scene, c) => {
      const l = leg(scene, c.walls[0]);
      return l ? l.pb.x - l.pa.x : null;
    },
    gradient: (scene, c) => {
      const l = leg(scene, c.walls[0]);
      return l ? [{ nodeId: l.b, dx: 1, dy: 0 }, { nodeId: l.a, dx: -1, dy: 0 }] : [];
    },
    initialValue: () => null,
    applicable: (scene, walls) => walls.length === 1 && !!scene.walls[walls[0]],
  },

  distance: {
    label: '長さ',
    arity: 1,
    usesValue: true,
    glyph: '↔',
    residual: (scene, c) => {
      const l = leg(scene, c.walls[0]);
      if (!l || c.value === null) return null;
      return l.len - c.value;
    },
    gradient: (scene, c) => {
      const l = leg(scene, c.walls[0]);
      if (!l) return [];
      // ∂|d|/∂pb = u、∂|d|/∂pa = −u
      return [
        { nodeId: l.b, dx: l.ux, dy: l.uy },
        { nodeId: l.a, dx: -l.ux, dy: -l.uy },
      ];
    },
    initialValue: (scene, walls) => leg(scene, walls[0])?.len ?? null,
    applicable: (scene, walls) => walls.length === 1 && !!scene.walls[walls[0]],
  },

  parallel: {
    label: '平行',
    arity: 2,
    usesValue: false,
    glyph: '//',
    residual: (scene, c) => {
      const pair = legs(scene, c);
      if (!pair) return null;
      const [x, y] = pair;
      return ANGULAR_SCALE * (x.ux * y.uy - x.uy * y.ux); // S·sinθ
    },
    gradient: (scene, c) => {
      const pair = legs(scene, c);
      if (!pair) return [];
      const [x, y] = pair;
      // ∂cross/∂u = (v.y, −v.x)、∂cross/∂v = (−u.y, u.x)
      return angularGradient(x, y, { x: y.uy, y: -y.ux }, { x: -x.uy, y: x.ux });
    },
    initialValue: () => null,
    applicable: (scene, walls) =>
      walls.length === 2 && walls[0] !== walls[1] && !!scene.walls[walls[0]] && !!scene.walls[walls[1]],
  },

  perpendicular: {
    label: '直角',
    arity: 2,
    usesValue: false,
    glyph: '⊥',
    residual: (scene, c) => {
      const pair = legs(scene, c);
      if (!pair) return null;
      const [x, y] = pair;
      return ANGULAR_SCALE * (x.ux * y.ux + x.uy * y.uy); // S·cosθ
    },
    gradient: (scene, c) => {
      const pair = legs(scene, c);
      if (!pair) return [];
      const [x, y] = pair;
      // ∂dot/∂u = v、∂dot/∂v = u
      return angularGradient(x, y, { x: y.ux, y: y.uy }, { x: x.ux, y: x.uy });
    },
    initialValue: () => null,
    applicable: (scene, walls) =>
      walls.length === 2 && walls[0] !== walls[1] && !!scene.walls[walls[0]] && !!scene.walls[walls[1]],
  },
};

/** 拘束が実際に動かしうるノード。連結成分の分割に使う */
export function constraintNodes(scene: Scene, c: Constraint): Id[] {
  const out: Id[] = [];
  for (const wallId of c.walls) {
    const wall = scene.walls[wallId];
    if (!wall) continue;
    if (!out.includes(wall.a)) out.push(wall.a);
    if (!out.includes(wall.b)) out.push(wall.b);
  }
  return out;
}

/** 人が読むラベル。インスペクタの一覧に出す */
export function constraintLabel(c: Constraint): string {
  const spec = CONSTRAINT_SPECS[c.kind];
  if (!spec.usesValue || c.value === null) return spec.label;
  return `${spec.label} ${Math.round(c.value).toLocaleString()} mm`;
}

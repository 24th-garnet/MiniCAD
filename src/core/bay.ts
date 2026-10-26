import { add, mul, type Vec } from './geometry.ts';
import type { Opening } from './types.ts';
import type { OpeningFrame } from './shape.ts';
import type { Primitive } from './primitive.ts';

/**
 * 出窓とニッチ。
 *
 * **`OpeningKind` を増やさない。** ワイヤーは建具に「出窓 / L型出窓 / U型出窓 /
 * ハーフ出窓」を並べているが、JIS A 0150 の平面では**出窓も普通の窓も同じ記号**で、
 * 違うのは壁から張り出す箱の方。種別を増やすと `OPENING_SYMBOLS` に同じ記号が
 * 並び、どれを選んでも平面図が同じものが 4 つできる。
 *
 * **出窓は「窓 ＋ 張り出し」。** 壁の穴は `Opening` がすでに開けているので、
 * ここで持つのは張り出す箱の形だけ。`wallSpans` にも `WallHole` にも触らない。
 * ニッチは同じものが内側へ凹んだだけなので、**奥行の符号**で表す。
 *
 * 「ハーフ出窓」は窓台の高さ（`sillHeight`）が違うだけなので、欄は要らない。
 * **L 型・U 型は角をまたぐ**ので、1 つの壁に付く `Opening` では表せない。
 * まだ無い（[README](../../README.md) の「構造」に書いてある）。
 */
export const BAY_SHAPES = ['box', 'trapezoid', 'bow'] as const;

export type BayShape = (typeof BAY_SHAPES)[number];

export const BAY_LABELS: Record<BayShape, string> = {
  box: '角型',
  trapezoid: '台形',
  bow: '弓型',
};

const BAY_SHAPE_SET: ReadonlySet<string> = new Set<string>(BAY_SHAPES);

export const isBayShape = (v: unknown): v is BayShape =>
  typeof v === 'string' && BAY_SHAPE_SET.has(v);

export interface Bay {
  shape: BayShape;
  /** 壁面からの出 (mm)。**負ならニッチ**（室内側へ凹む） */
  depth: number;
  /** どちら側へ出るか。壁の法線の向きで +1 / -1 */
  side: 1 | -1;
}

/** 台形の斜めの部分が、幅のどれだけを食うか */
const TRAPEZOID_INSET = 0.25;

/** 弓型の円弧を折れ線にするときの分割数 */
const BOW_SEGMENTS = 12;

export const defaultBay = (): Bay => ({ shape: 'box', depth: 450, side: 1 });

/**
 * 張り出し（または凹み）の輪郭。ワールド座標、反時計回りとは限らない。
 *
 * 壁面の 2 点から出て戻る閉じた多角形で返す。先頭と末尾が壁の上の点なので、
 * そのまま塗っても線で描いても壁と繋がって見える。
 */
export function bayOutline(frame: OpeningFrame, bay: Bay): Vec[] {
  const half = frame.width / 2;
  const at = (along: number, off: number): Vec =>
    add(add(frame.center, mul(frame.dir, along)), mul(frame.normal, off));

  // **壁の面から測る。壁芯からではない。** 壁芯から測ると、出 450 の出窓が
  // 壁厚の半分だけ短く出る
  const near = (frame.thickness / 2) * bay.side;
  // 出が正なら面の外へ、負なら壁の中へ。どちらも `side` の向きに沿う
  const far = near + bay.depth * bay.side;

  switch (bay.shape) {
    case 'box':
      return [at(-half, near), at(-half, far), at(half, far), at(half, near)];
    case 'trapezoid': {
      const inset = half * TRAPEZOID_INSET * 2;
      return [at(-half, near), at(-half + inset, far), at(half - inset, far), at(half, near)];
    }
    case 'bow': {
      // 開口の幅を弦、出を矢高とする円弧。半径は弦と矢高から決まる
      const sagitta = Math.abs(far - near);
      if (sagitta < 1e-6) return [at(-half, near), at(half, near)];
      const u = far > near ? 1 : -1;
      const radius = (half * half + sagitta * sagitta) / (2 * sagitta);
      const center = far - u * radius;
      const sweep = Math.asin(Math.min(1, half / radius));
      const points: Vec[] = [];
      for (let i = 0; i <= BOW_SEGMENTS; i++) {
        const t = -sweep + (2 * sweep * i) / BOW_SEGMENTS;
        points.push(at(radius * Math.sin(t), center + u * radius * Math.cos(t)));
      }
      return points;
    }
  }
}

/** 平面に出すもの。張り出しの輪郭だけで、窓の記号は `OPENING_SYMBOLS` が出す */
export function bayPrimitives(frame: OpeningFrame, bay: Bay): Primitive[] {
  if (Math.abs(bay.depth) < 1e-6) return [];
  return [{ kind: 'segments', segments: chain(bayOutline(frame, bay)) }];
}

const chain = (points: Vec[]): { a: Vec; b: Vec }[] =>
  points.slice(1).map((b, i) => ({ a: points[i], b }));

/** 張り出しを持っているか。`null` と出 0 を 1 箇所で判定する */
export const hasBay = (opening: Opening): boolean =>
  opening.bay !== null && Math.abs(opening.bay.depth) > 1e-6;

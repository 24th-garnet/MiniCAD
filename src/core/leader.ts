import { add, dist, mul, norm, sub, vec, type Vec } from './geometry.ts';
import type { Primitive } from './primitive.ts';
import type { Segment } from './shape.ts';
import type { LeaderShape } from './shapes.ts';
import { paperToWorld, type DrawingStandard } from './standard.ts';

/**
 * 引出線付き注釈。**指す点から引き出して、水平な棚の上に文字を置く。**
 *
 * 組み方は寸法（`core/dimension.ts`）に揃えてある:
 * 幾何だけを返す関数 → `primitives()` はそれを詰め替えるだけ →
 * `vertices` / `outline` / `snapPoints` が同じ幾何を再利用する。
 *
 * **指した先には連動しない。** 寸法は `DimEnd`（`nodeId` で壁の角に紐づき、
 * 複写のときのノード付け替えまで面倒を見る）を持っているが、
 * 同じものを注釈にも作ると実装が倍近くになる。注釈は点を指すだけ。
 *
 * **矢印は持たない。** 寸法が建築の慣例どおり 45 度の斜線を使っているので、
 * 注釈もそれに揃える。
 */

/** 棚（文字を乗せる水平部）の長さ。紙の上の mm */
const LANDING_PAPER_MM = 8;

/** 指した点に打つ斜線の長さ。紙の上の mm */
const TICK_PAPER_MM = 1.2;

/** 文字を棚から浮かせる量。紙の上の mm */
const TEXT_LIFT_PAPER_MM = 0.7;

export interface LeaderGeometry {
  /** 指している点 */
  at: Vec;
  /** 引出線の折れ点 */
  elbow: Vec;
  /** 棚の反対側の端 */
  tail: Vec;
  /** 引出線と棚 */
  segments: Segment[];
  /** 指した点の斜線 */
  tick: Segment;
  textAt: Vec;
  /** 棚がどちらへ伸びるか。+1 なら右 */
  side: 1 | -1;
}

export function leaderGeometry(l: LeaderShape, std: DrawingStandard): LeaderGeometry {
  const landing = paperToWorld(LANDING_PAPER_MM, std);
  const side: 1 | -1 = l.elbow.x >= l.at.x ? 1 : -1;
  const tail = add(l.elbow, vec(landing * side, 0));

  const lead = sub(l.elbow, l.at);
  // 指した点と折れ点が同じなら向きが決まらない。真上を向かせる
  const dir = dist(l.at, l.elbow) < 1e-6 ? vec(0, 1) : norm(lead);
  const tickLen = paperToWorld(TICK_PAPER_MM, std);
  const tickDir = vec(-dir.y, dir.x);

  return {
    at: l.at,
    elbow: l.elbow,
    tail,
    segments: [
      { a: l.at, b: l.elbow },
      { a: l.elbow, b: tail },
    ],
    tick: { a: sub(l.at, mul(tickDir, tickLen)), b: add(l.at, mul(tickDir, tickLen)) },
    // **折れ点に合わせて棚の上に乗せる。** 棚の中点を基準にすると、
    // 文字が棚より長いときに反対側へはみ出す
    textAt: add(l.elbow, vec(0, paperToWorld(l.height * TEXT_LIFT_PAPER_MM, std))),
    side,
  };
}

export function leaderPrimitives(l: LeaderShape, std: DrawingStandard): Primitive[] {
  const g = leaderGeometry(l, std);
  const text = l.text.trim();
  return [
    { kind: 'segments', segments: [...g.segments, g.tick] },
    ...(text
      ? [{
          kind: 'text' as const,
          text,
          at: g.textAt,
          paperMm: l.height,
          angle: 0,
          // 棚が右へ伸びるなら文字は左寄せ。棚の上に乗る
          align: (g.side > 0 ? 'left' : 'right') as 'left' | 'right',
        }]
      : []),
  ];
}


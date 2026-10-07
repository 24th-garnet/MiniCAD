import type { Vec } from './geometry.ts';
import type { Segment } from './shape.ts';

export type TextAlign = 'left' | 'center' | 'right';

/**
 * 画面・SVG・DXF のどれにも依存しない描画の中間表現。
 *
 * これを挟まないと、図形を1種類足すたびに renderer / svg / dxf の3箇所へ
 * 同じことを書くことになる。図形は `primitives()` でここへ落とし、
 * 出力側は3つのバックエンドだけを持つ。
 *
 * 座標はすべてワールドの mm。文字高だけは紙の上の mm で持つ
 * （線幅・文字高は尺度を介して世界座標に直す、という既存の規約に合わせる）。
 */
export type Primitive =
  | { kind: 'segments'; segments: Segment[] }
  /** start から end へ反時計回り。角度はラジアン */
  | { kind: 'arc'; center: Vec; radius: number; startAngle: number; endAngle: number }
  | { kind: 'circle'; center: Vec; radius: number }
  | { kind: 'polygon'; points: Vec[]; fill: 'layer' | 'paper' | 'none' }
  | {
      kind: 'text';
      text: string;
      at: Vec;
      /** 紙の上の mm */
      paperMm: number;
      angle: number;
      align: TextAlign;
      /** 画層の色を使わずに上書きしたいとき */
      color?: string;
    };

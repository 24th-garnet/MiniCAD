import type { Vec } from './geometry.ts';
import type { Segment } from './shape.ts';
import type { LineType } from './standard.ts';

export type TextAlign = 'left' | 'center' | 'right';

/**
 * 線を引くプリミティブに共通の指定。
 *
 * `lineType` は**記号そのものが持つ線種**のためにある。ドアの開き軌跡や
 * 引込み戸の戸袋は、画層の線種が何であれ破線で描くのが JIS の記号。
 * 省略すれば画層の線種に従う（こちらが普通）。
 */
interface Stroke {
  lineType?: LineType;
}

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
  | (Stroke & { kind: 'segments'; segments: Segment[] })
  /** start から end へ反時計回り。角度はラジアン */
  | (Stroke & { kind: 'arc'; center: Vec; radius: number; startAngle: number; endAngle: number })
  | (Stroke & { kind: 'circle'; center: Vec; radius: number })
  | (Stroke & { kind: 'polygon'; points: Vec[]; fill: 'layer' | 'paper' | 'none' })
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

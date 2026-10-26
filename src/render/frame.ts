import type { Vec } from '../core/geometry.ts';
import { getLayer, layerDashWorld, layerWeight, lineTypeDashWorld, type Layer } from '../core/layer.ts';
import type { LineType } from '../core/standard.ts';
import { PX_PER_MM, paperToScreenPx } from '../core/standard.ts';
import type { Settings } from '../core/store.ts';
import type { EntityRef, Room, Scene } from '../core/types.ts';
import type { CommentAnchor } from '../core/annotation.ts';
import { Viewport } from './viewport.ts';

/** 1回の描画に必要なものをまとめたもの。描画関数は状態を持たない */
export interface Frame {
  ctx: CanvasRenderingContext2D;
  vp: Viewport;
  scene: Scene;
  rooms: Room[];
  settings: Settings;
  /** `type:id` の集合 */
  selected: Set<string>;
  hover: EntityRef | null;
  /** 直近の solve で満たせなかった拘束の id。赤く出す。見た目だけの情報なので省略可 */
  violated?: Set<string>;
  /**
   * コメントのアンカー。**シーンには入らない。**
   * ホストから渡されるもので、図面を保存しても付いてこない
   */
  comments?: CommentAnchor[];
}

export const refKey = (ref: EntityRef): string => `${ref.type}:${ref.id}`;

/** 画層を引く。見つからなければ既定の画層に落とす */
export const layerFor = (frame: Frame, id: string | undefined, fallback: string): Layer =>
  getLayer(frame.scene.layers, id, fallback);

/**
 * 線の太さは「紙の上の mm」なので、画面ではズームに依らず一定のピクセル数で描く。
 * CAD の線幅表示と同じ考え方。
 */
export const strokePx = (frame: Frame, layer: Layer): number =>
  paperToScreenPx(layerWeight(layer, frame.scene.standard));

/** 文字も紙の上の mm。画面は「原寸の紙」として扱う */
export const textPx = (paperMm: number): number => Math.max(8, paperMm * PX_PER_MM);

/** 線種のダッシュを画面のピクセルに直す。ワールド基準なのでズームに追従する */
export function dashPx(frame: Frame, layer: Layer): number[] {
  return dashWorldToPx(frame, layerDashWorld(layer, frame.scene.standard));
}

const dashWorldToPx = (frame: Frame, mm: number[]): number[] =>
  mm.map((v) => Math.max(1, frame.vp.toScreenLength(v)));

/**
 * 画層の見た目を ctx に当てる。
 *
 * `overrideLineType` は**そのものが持つ線種**のためにある。切断面より上に
 * あるもの（垂れ壁）は、画層の線種が何であれ破線で描くのが製図の作法。
 * `Primitive` の `lineType` と同じ考え方。
 */
export function applyLayer(
  frame: Frame,
  layer: Layer,
  overrideColor?: string | null,
  overrideLineType?: LineType,
): void {
  const { ctx } = frame;
  ctx.strokeStyle = overrideColor ?? layer.color;
  ctx.lineWidth = strokePx(frame, layer);
  ctx.setLineDash(
    overrideLineType
      ? dashWorldToPx(frame, lineTypeDashWorld(overrideLineType, frame.scene.standard))
      : dashPx(frame, layer),
  );
}

/** beginPath から closePath まで。塗るか描くかは呼び出し側が決める */
export function tracePolygon(frame: Frame, poly: Vec[]): void {
  const { ctx, vp } = frame;
  ctx.beginPath();
  poly.forEach((p, i) => {
    const s = vp.toScreen(p);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  ctx.closePath();
}

/** 複数の線分を1本のパスにまとめて描く */
export function strokeSegments(frame: Frame, segments: { a: Vec; b: Vec }[]): void {
  const { ctx, vp } = frame;
  ctx.beginPath();
  for (const s of segments) {
    const a = vp.toScreen(s.a);
    const b = vp.toScreen(s.b);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
}

/** 文字が上下逆にならないよう ±90° の範囲に畳む */
export function normalizeTextAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI / 2) a -= Math.PI;
  while (a < -Math.PI / 2) a += Math.PI;
  return a;
}

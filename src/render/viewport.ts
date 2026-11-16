import { vec, type Bounds, type Vec } from '../core/geometry.ts';

const MIN_SCALE = 0.002; // 1px = 500mm
const MAX_SCALE = 2; // 1px = 0.5mm

/**
 * ワールド(mm, y上向き) と 画面(CSS px, y下向き) の変換。
 * origin は「ワールド原点が画面のどこに来るか」を px で持つ。
 */
export class Viewport {
  /** px per mm */
  scale = 0.06;
  origin: Vec = vec(0, 0);
  width = 0;
  height = 0;

  toScreen(w: Vec): Vec {
    return vec(this.origin.x + w.x * this.scale, this.origin.y - w.y * this.scale);
  }

  toWorld(s: Vec): Vec {
    return vec((s.x - this.origin.x) / this.scale, -(s.y - this.origin.y) / this.scale);
  }

  /** 画面上の px 距離をワールドの mm に直す */
  toWorldLength(px: number): number {
    return px / this.scale;
  }

  toScreenLength(mm: number): number {
    return mm * this.scale;
  }

  panBy(dxPx: number, dyPx: number): void {
    this.origin = vec(this.origin.x + dxPx, this.origin.y + dyPx);
  }

  /** 画面上の点 anchor を固定したままズームする */
  zoomAt(anchor: Vec, factor: number): void {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
    const applied = next / this.scale;
    this.origin = vec(
      anchor.x - (anchor.x - this.origin.x) * applied,
      anchor.y - (anchor.y - this.origin.y) * applied,
    );
    this.scale = next;
  }

  /**
   * 画面の寸法が変わったとき。
   *
   * **倍率は保ち、画面の中心にあったものを中心に残す。**
   *
   * 倍率を保つのは CAD の流儀（AutoCAD も窓を変えて縮尺は変わらない）。
   * 問題はもう一方で、以前は `origin` に手を付けなかった——`origin` は
   * 「ワールド原点が画面のどこに来るか」を**画面の左上から**測った px なので、
   * 触らないと**左上に貼り付いたまま**になる。箱が縮むと図面が右下へ逃げ、
   * 実測では 568×530 まで縮めた時点で**間取りが丸ごと枠の外**に出た。
   *
   * 中心を基準にすれば、縮んでも見ていたものが真ん中に残って、周りから
   * 均等に切れる。半分だけずらせば足りる。
   *
   * **初回は動かさない。** まだ寸法を知らない（`width === 0`）ときは
   * ずらす基準が無く、このあと `fit` が来る。
   */
  resize(width: number, height: number): void {
    if (this.width !== 0 && this.height !== 0) {
      this.origin = vec(
        this.origin.x + (width - this.width) / 2,
        this.origin.y + (height - this.height) / 2,
      );
    }
    this.width = width;
    this.height = height;
  }

  /** 指定範囲が画面に収まるよう合わせる */
  fit(bounds: Bounds | null, paddingPx = 80): void {
    if (!bounds || this.width === 0 || this.height === 0) {
      this.scale = 0.06;
      this.origin = vec(this.width / 2, this.height / 2);
      return;
    }
    const w = Math.max(1, bounds.max.x - bounds.min.x);
    const h = Math.max(1, bounds.max.y - bounds.min.y);
    const sx = (this.width - paddingPx * 2) / w;
    const sy = (this.height - paddingPx * 2) / h;
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(sx, sy)));
    const cx = (bounds.min.x + bounds.max.x) / 2;
    const cy = (bounds.min.y + bounds.max.y) / 2;
    this.origin = vec(this.width / 2 - cx * this.scale, this.height / 2 + cy * this.scale);
  }

  /** 現在の表示範囲（ワールド） */
  visibleBounds(): Bounds {
    const a = this.toWorld(vec(0, 0));
    const b = this.toWorld(vec(this.width, this.height));
    return {
      min: vec(Math.min(a.x, b.x), Math.min(a.y, b.y)),
      max: vec(Math.max(a.x, b.x), Math.max(a.y, b.y)),
    };
  }
}

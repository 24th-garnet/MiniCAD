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

  resize(width: number, height: number): void {
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

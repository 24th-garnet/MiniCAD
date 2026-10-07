import { angleOf, dist, norm, sub, toDeg, type Vec } from '../core/geometry.ts';
import { addWall, findOrCreateNode, splitWall } from '../core/ops.ts';
import { pointFromPolar } from '../core/snap.ts';
import type { Id } from '../core/types.ts';
import { drawPreviewWall, drawSnapMarker, type Frame } from '../render/renderer.ts';
import type { Editor } from '../ui/editor.ts';
import type { NumericEntry, PointerInfo, Tool } from './tool.ts';

/**
 * 壁を連続して引くツール。
 * CAD らしさの肝は「方向はマウス、長さはキーボード」なので、作図中はいつでも
 * 数値入力欄に `3000` や `3000<90` と打ち込める。
 */
export class WallTool implements Tool {
  readonly id = 'wall' as const;
  readonly label = '壁';
  readonly shortcut = 'W';
  readonly cursor = 'crosshair';

  private anchor: Vec | null = null;

  onActivate(editor: Editor): void {
    editor.store.clearSelection();
    this.anchor = null;
    editor.snapContext = {};
  }

  onDeactivate(editor: Editor): void {
    this.anchor = null;
    editor.snapContext = {};
  }

  isActive(): boolean {
    return this.anchor !== null;
  }

  cancel(editor: Editor): void {
    this.anchor = null;
    editor.snapContext = {};
    editor.requestRender();
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;
    if (!this.anchor) {
      this.anchor = p.world;
      editor.snapContext = { from: this.anchor };
      return;
    }
    this.placeSegment(editor, p.world);
  }

  onDoubleClick(editor: Editor): void {
    this.cancel(editor);
  }

  onKeyDown(editor: Editor, e: KeyboardEvent): boolean {
    if ((e.key === 'Enter' || e.key === 'Escape') && this.anchor) {
      this.cancel(editor);
      return true;
    }
    return false;
  }

  /** 1本の壁を確定し、終点を次の起点にして連続作図を続ける */
  private placeSegment(editor: Editor, end: Vec): void {
    const start = this.anchor;
    if (!start) return;
    if (dist(start, end) < 1) return;

    const store = editor.store;
    store.commit(() => {
      const scene = store.scene;
      const tolerance = editor.viewport.toWorldLength(6);
      const a = resolveNode(editor, start, tolerance);
      const b = resolveNode(editor, end, tolerance);
      if (a === b) return false;
      addWall(scene, a, b, store.settings.wallThickness);
      return true;
    });

    this.anchor = end;
    editor.snapContext = { from: this.anchor };
  }

  numericEntry(_editor: Editor): NumericEntry | null {
    if (!this.anchor) return null;
    return {
      placeholder: '長さ  例: 3000 / 3000<90',
      hint: '長さ[mm] と 角度[°] を `<` か `,` で区切って入力し Enter',
      submit: (ed, text) => this.submitNumeric(ed, text),
    };
  }

  private submitNumeric(editor: Editor, text: string): void {
    const anchor = this.anchor;
    if (!anchor) return;
    const parsed = parsePolar(text);
    if (!parsed) return;

    let angleDeg = parsed.angleDeg;
    if (angleDeg === null) {
      // 角度の指定がなければ、いまマウスが指している向き（角度スナップ後）を使う
      const pointer = editor.snapAt(editor.pointerWorld()).point;
      const d = sub(pointer, anchor);
      if (dist(anchor, pointer) < 1e-6) return;
      angleDeg = toDeg(angleOf(norm(d)));
    }
    this.placeSegment(editor, pointFromPolar(anchor, parsed.length, angleDeg));
    editor.requestRender();
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    const snap = editor.lastSnap;
    if (this.anchor && snap) {
      drawPreviewWall(frame, this.anchor, snap.point, editor.store.settings.wallThickness);
    }
    if (snap && snap.kind !== 'free') drawSnapMarker(frame, snap.point, snap.label);
  }

  status(): string {
    return this.anchor
      ? 'クリックで次の点 / 数値を打ち込んで Enter / Esc・右クリック・ダブルクリックで終了'
      : 'クリックで壁の始点を指定';
  }
}

/** 点をノードに解決する。既存の壁の上なら壁を分割して本当に接続する */
function resolveNode(editor: Editor, p: Vec, tolerance: number): Id {
  const scene = editor.store.scene;
  for (const n of Object.values(scene.nodes)) {
    if (dist(p, n) <= tolerance) return n.id;
  }
  const snap = editor.snapAt(p);
  if (snap.kind === 'wall' && snap.wallId) {
    const split = splitWall(scene, snap.wallId, p, tolerance);
    if (split) return split;
  }
  return findOrCreateNode(scene, p, tolerance);
}

/** `3000` / `3000<45` / `3000,45` を長さと角度に分解する */
export function parsePolar(text: string): { length: number; angleDeg: number | null } | null {
  const cleaned = text.trim().replace(/\s+/g, '');
  if (!cleaned) return null;
  const m = cleaned.match(/^(-?[\d.]+)(?:[<,](-?[\d.]+))?$/);
  if (!m) return null;
  const length = Number(m[1]);
  if (!Number.isFinite(length) || length === 0) return null;
  const angle = m[2] === undefined ? null : Number(m[2]);
  if (angle !== null && !Number.isFinite(angle)) return null;
  return { length: Math.abs(length), angleDeg: angle };
}

import { angleOf, dist, norm, sub, toDeg, type Vec } from '../core/geometry.ts';
import { LAYER_IDS, resolveNewLayer } from '../core/layer.ts';
import { addWall, findOrCreateNode, splitWall } from '../core/ops.ts';
import { resolvePoint, type CoordInput } from '../core/coord-input.ts';
import type { Id } from '../core/types.ts';
import { drawPreviewWall, drawSnapMarker, type Frame } from '../render/renderer.ts';
import type { Editor } from '../ui/editor.ts';
import type { NumericEntry, OptionField, PointerInfo, Tool } from './tool.ts';

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
  readonly group = 'draw' as const;

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
      addWall(scene, a, b, store.settings.wallThickness, resolveNewLayer(scene.layers, store.settings.currentLayerId, LAYER_IDS.wall));
      return true;
    });

    this.anchor = end;
    editor.snapContext = { from: this.anchor };
  }

  numericEntry(_editor: Editor): NumericEntry | null {
    return {
      mode: 'point',
      base: this.anchor,
      // 角度を省いたら、いまマウスが指している向き（角度スナップ後）を使う
      fallbackAngleDeg: (ed) => pointerAngleFrom(ed, this.anchor),
      submit: (ed, input) => this.submitNumeric(ed, input),
    };
  }

  private submitNumeric(editor: Editor, input: CoordInput): void {
    const point = resolvePoint(input, this.anchor, pointerAngleFrom(editor, this.anchor));
    if (!point) return;
    if (!this.anchor) {
      // 作図前でも絶対座標で始点を置ける
      this.anchor = point;
      editor.snapContext = { from: this.anchor };
    } else {
      this.placeSegment(editor, point);
    }
    editor.requestRender();
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    const snap = editor.lastSnap;
    if (this.anchor && snap) {
      drawPreviewWall(frame, this.anchor, snap.point, editor.store.settings.wallThickness);
    }
    if (snap && snap.kind !== 'free') drawSnapMarker(frame, snap.point, snap.label);
  }

  options(editor: Editor): OptionField[] {
    const settings = editor.store.settings;
    return [
      {
        kind: 'number',
        label: '壁厚 (mm)',
        value: settings.wallThickness,
        step: 10,
        min: 10,
        onChange: (v) => void (settings.wallThickness = Math.max(10, v)),
      },
    ];
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
  return findOrCreateNode(scene, p, scene.activeLevelId, tolerance);
}

/** いまマウスが指している向き（角度スナップ後）。角度を省いた入力で使う */
export function pointerAngleFrom(editor: Editor, from: Vec | null): number | null {
  if (!from) return null;
  const pointer = editor.snapAt(editor.pointerWorld()).point;
  if (dist(from, pointer) < 1e-6) return null;
  return toDeg(angleOf(norm(sub(pointer, from))));
}

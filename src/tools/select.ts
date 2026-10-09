import { resolveDelta, type CoordInput } from '../core/coord-input.ts';
import { dist, sub, vec, type Vec } from '../core/geometry.ts';
import { pickInRect } from '../core/pick.ts';
import { mergeNodesAt } from '../core/ops.ts';
import { translation } from '../core/transform.ts';
import { transformEntities } from '../core/transformOps.ts';
import {
  captureOrigins,
  isEmptySelection,
  placeSelection,
  resolveSelection,
  selectionCenter as resolvedCenter,
  translateSelection,
  type MoveOrigins,
  type ResolvedSelection,
} from '../core/selection.ts';
import type { EntityRef, Scene } from '../core/types.ts';
import { drawPreviewRect, drawSnapMarker, type Frame } from '../render/renderer.ts';
import type { Editor } from '../ui/editor.ts';
import type { NumericEntry, PointerInfo, Tool } from './tool.ts';

type DragState =
  | { kind: 'none' }
  | { kind: 'pending'; start: Vec; ref: EntityRef }
  | {
      kind: 'move';
      start: Vec;
      before: Scene;
      sel: ResolvedSelection;
      origins: MoveOrigins;
      moved: boolean;
      /** Alt を押しながら始めたら複写移動 */
      copy: boolean;
      /** 直近に適用した変位。複写移動の確定に使う */
      delta: Vec;
    }
  | { kind: 'rect'; start: Vec; current: Vec; additive: boolean };

export class SelectTool implements Tool {
  readonly id = 'select' as const;
  readonly label = '選択';
  readonly shortcut = 'V';
  readonly cursor = 'default';
  readonly group = 'modify' as const;

  private drag: DragState = { kind: 'none' };

  onDeactivate(): void {
    this.drag = { kind: 'none' };
  }

  isActive(): boolean {
    return this.drag.kind === 'move' || this.drag.kind === 'rect';
  }

  cancel(editor: Editor): void {
    if (this.drag.kind === 'move') {
      editor.store.scene = this.drag.before;
      editor.notifyChanged();
    }
    this.drag = { kind: 'none' };
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;
    const ref = editor.pick(p.raw);
    const store = editor.store;

    if (!ref) {
      if (!p.shift) store.clearSelection();
      this.drag = { kind: 'rect', start: p.raw, current: p.raw, additive: p.shift };
      return;
    }

    if (p.shift) {
      store.toggleSelection(ref);
    } else if (!store.isSelected(ref)) {
      store.setSelection([ref]);
    }
    this.drag = { kind: 'pending', start: p.world, ref };
  }

  onPointerMove(editor: Editor, p: PointerInfo): void {
    const drag = this.drag;
    if (drag.kind === 'rect') {
      drag.current = p.raw;
      return;
    }
    if (drag.kind === 'pending') {
      if (editor.isSameSpot(drag.start, p.world)) return;
      const sel = resolveSelection(editor.store.scene, editor.store.selection);
      if (isEmptySelection(sel)) {
        this.drag = { kind: 'none' };
        return;
      }
      // 自分自身にスナップしないよう除外しておく
      editor.snapContext = { excludeNodes: sel.nodeIds };
      this.drag = {
        kind: 'move',
        start: drag.start,
        before: structuredClone(editor.store.scene),
        sel,
        origins: captureOrigins(editor.store.scene, sel),
        moved: false,
        copy: p.alt,
        delta: vec(0, 0),
      };
      this.applyMove(editor, p);
      return;
    }
    if (drag.kind === 'move') {
      this.applyMove(editor, p);
    }
  }

  onPointerUp(editor: Editor, p: PointerInfo): void {
    const drag = this.drag;
    this.drag = { kind: 'none' };
    editor.snapContext = {};

    if (drag.kind === 'rect') {
      const a = drag.start;
      const b = p.raw;
      if (dist(a, b) < editor.viewport.toWorldLength(3)) return;
      // 左→右は完全包含、右→左は交差選択（AutoCAD 以来の作法）
      const crossing = b.x < a.x;
      const min = vec(Math.min(a.x, b.x), Math.min(a.y, b.y));
      const max = vec(Math.max(a.x, b.x), Math.max(a.y, b.y));
      const found = pickInRect(editor.store.scene, min, max, crossing);
      editor.store.setSelection(drag.additive ? dedupe([...editor.store.selection, ...found]) : found);
      return;
    }

    if (drag.kind === 'move' && drag.moved) {
      if (drag.copy) {
        // ドラッグ中は元を動かしていたので、いったん操作前に戻してから複製を作る
        const restored = drag.before;
        editor.store.scene = structuredClone(restored);
        const result = transformEntities(editor.store.scene, [...editor.store.selection], translation(drag.delta), {
          copy: true,
        });
        editor.store.commitFrom(restored);
        if (result.refs.length > 0) editor.store.setSelection(result.refs);
      } else {
        if (drag.sel.nodeIds.length > 0) mergeNodesAt(editor.store.scene, drag.sel.nodeIds);
        editor.store.commitFrom(drag.before);
      }
    }
  }

  private applyMove(editor: Editor, p: PointerInfo): void {
    const drag = this.drag;
    if (drag.kind !== 'move') return;
    const settings = editor.store.settings;
    const single =
      drag.sel.nodeIds.length === 1 && drag.sel.instanceIds.length === 0 && drag.sel.roomLabelIds.length === 0;

    let delta = sub(p.raw, drag.start);
    if (single) {
      // 単独のノードはスナップ点へ直接寄せる
      const origin = drag.origins.nodes.get(drag.sel.nodeIds[0]);
      if (origin) delta = sub(p.world, origin);
    } else if (settings.snapGrid && settings.gridSize > 0) {
      const g = settings.gridSize;
      delta = vec(Math.round(delta.x / g) * g, Math.round(delta.y / g) * g);
    }

    placeSelection(editor.store.scene, drag.origins, delta);
    drag.delta = delta;
    drag.moved = true;
    editor.notifyChanged();
  }

  onKeyDown(editor: Editor, e: KeyboardEvent): boolean {
    const store = editor.store;
    const step = e.shiftKey ? store.settings.gridSize * 10 : store.settings.gridSize;
    const nudge: Record<string, Vec> = {
      ArrowLeft: vec(-step, 0),
      ArrowRight: vec(step, 0),
      ArrowUp: vec(0, step),
      ArrowDown: vec(0, -step),
    };
    if (e.key in nudge && store.selection.length > 0) {
      const delta = nudge[e.key];
      store.commit(() => {
        const sel = resolveSelection(store.scene, store.selection);
        if (isEmptySelection(sel)) return false;
        translateSelection(store.scene, sel, delta);
      });
      return true;
    }

    // ブロックの回転
    if (e.key === '[' || e.key === ']') {
      const items = store.selection.filter((s) => s.type === 'blockInstance');
      if (items.length === 0) return false;
      const sign = e.key === ']' ? 1 : -1;
      const amount = (sign * Math.PI) / (e.shiftKey ? 36 : 4);
      store.commit(() => {
        for (const ref of items) {
          const inst = store.scene.instances[ref.id];
          if (inst) inst.angle += amount;
        }
      });
      return true;
    }
    return false;
  }

  /** 作図していなくても、選択があれば数値で動かせる */
  numericEntry(editor: Editor): NumericEntry | null {
    const sel = resolveSelection(editor.store.scene, editor.store.selection);
    if (isEmptySelection(sel)) return null;
    return {
      mode: 'delta',
      base: resolvedCenter(editor.store.scene, sel),
      hint: '選択を動かす変位',
      submit: (ed, input) => this.submitMove(ed, input),
    };
  }

  private submitMove(editor: Editor, input: CoordInput): void {
    const store = editor.store;
    const sel = resolveSelection(store.scene, store.selection);
    if (isEmptySelection(sel)) return;
    const delta = resolveDelta(input, resolvedCenter(store.scene, sel), null);
    if (!delta || (delta.x === 0 && delta.y === 0)) return;
    store.commit(() => {
      translateSelection(store.scene, sel, delta);
      if (sel.nodeIds.length > 0) mergeNodesAt(store.scene, sel.nodeIds);
    });
    editor.requestRender();
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    if (this.drag.kind === 'rect') {
      drawPreviewRect(frame, this.drag.start, this.drag.current, this.drag.current.x < this.drag.start.x);
      return;
    }
    const snap = editor.lastSnap;
    if (this.drag.kind === 'move' && snap && snap.kind !== 'free') {
      drawSnapMarker(frame, snap.point, snap.label);
    }
  }

  status(editor: Editor): string {
    const n = editor.store.selection.length;
    if (this.drag.kind === 'rect') return '左→右: 完全に含むものを選択 / 右→左: 触れるものを選択';
    if (n === 0) return 'クリックで選択・ドラッグで範囲選択 / Shift+クリックで追加';
    return `${n} 個を選択中 — ドラッグで移動（Alt で複写）、矢印キーで微調整、[ ] で家具を回転、Delete で削除`;
  }
}


function dedupe(refs: EntityRef[]): EntityRef[] {
  const seen = new Set<string>();
  const out: EntityRef[] = [];
  for (const r of refs) {
    const key = `${r.type}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** 選択範囲の中心。回転・鏡像の既定の基点に使う */
export function selectionCenter(editor: Editor): Vec | null {
  return resolvedCenter(editor.store.scene, resolveSelection(editor.store.scene, editor.store.selection));
}

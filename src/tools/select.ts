import { add, dist, dot, norm, sub, vec, type Vec } from '../core/geometry.ts';
import { pickInRect } from '../core/pick.ts';
import { clampOpening, mergeNodesAt, nodePos, wallEnds } from '../core/ops.ts';
import type { EntityRef, Id, Scene } from '../core/types.ts';
import { drawPreviewRect, drawSnapMarker, type Frame } from '../render/renderer.ts';
import type { Editor } from '../ui/editor.ts';
import type { PointerInfo, Tool } from './tool.ts';

interface MoveTarget {
  nodes: { id: Id; origin: Vec }[];
  furniture: { id: Id; origin: Vec }[];
  labels: { id: Id; origin: Vec }[];
  openings: { id: Id; origin: number }[];
}

type DragState =
  | { kind: 'none' }
  | { kind: 'pending'; start: Vec; ref: EntityRef }
  | { kind: 'move'; start: Vec; before: Scene; target: MoveTarget; moved: boolean }
  | { kind: 'rect'; start: Vec; current: Vec; additive: boolean };

export class SelectTool implements Tool {
  readonly id = 'select' as const;
  readonly label = '選択';
  readonly shortcut = 'V';
  readonly cursor = 'default';

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
      const target = collectMoveTarget(editor);
      if (target.nodes.length + target.furniture.length + target.labels.length + target.openings.length === 0) {
        this.drag = { kind: 'none' };
        return;
      }
      // 自分自身にスナップしないよう除外しておく
      editor.snapContext = { excludeNodes: target.nodes.map((n) => n.id) };
      this.drag = {
        kind: 'move',
        start: drag.start,
        before: structuredClone(editor.store.scene),
        target,
        moved: false,
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
      const movedIds = drag.target.nodes.map((n) => n.id);
      if (movedIds.length > 0) mergeNodesAt(editor.store.scene, movedIds);
      editor.store.commitFrom(drag.before);
    }
  }

  private applyMove(editor: Editor, p: PointerInfo): void {
    const drag = this.drag;
    if (drag.kind !== 'move') return;
    const scene = editor.store.scene;
    const settings = editor.store.settings;
    const single = drag.target.nodes.length === 1 && drag.target.furniture.length === 0 && drag.target.labels.length === 0;

    let delta = sub(p.raw, drag.start);
    if (single) {
      // 単独のノードはスナップ点へ直接寄せる
      delta = sub(p.world, drag.target.nodes[0].origin);
    } else if (settings.snapGrid && settings.gridSize > 0) {
      const g = settings.gridSize;
      delta = vec(Math.round(delta.x / g) * g, Math.round(delta.y / g) * g);
    }

    for (const n of drag.target.nodes) {
      const node = scene.nodes[n.id];
      if (!node) continue;
      node.x = n.origin.x + delta.x;
      node.y = n.origin.y + delta.y;
    }
    for (const f of drag.target.furniture) {
      const item = scene.furniture[f.id];
      if (!item) continue;
      item.x = f.origin.x + delta.x;
      item.y = f.origin.y + delta.y;
    }
    for (const l of drag.target.labels) {
      const label = scene.roomLabels[l.id];
      if (!label) continue;
      label.x = l.origin.x + delta.x;
      label.y = l.origin.y + delta.y;
    }
    for (const o of drag.target.openings) {
      const opening = scene.openings[o.id];
      const wall = opening && scene.walls[opening.wallId];
      if (!opening || !wall) continue;
      const [a, b] = wallEnds(scene, wall);
      const dir = norm(sub(b, a));
      // 開口は壁に沿ってしか動かない
      const along = dot(delta, dir);
      const next = clampOpening(scene, opening.wallId, o.origin + along, opening.width, opening.id);
      if (next !== null) opening.offset = next;
    }

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
        const target = collectMoveTarget(editor);
        for (const n of target.nodes) {
          const node = store.scene.nodes[n.id];
          if (node) {
            node.x += delta.x;
            node.y += delta.y;
          }
        }
        for (const f of target.furniture) {
          const item = store.scene.furniture[f.id];
          if (item) {
            item.x += delta.x;
            item.y += delta.y;
          }
        }
        for (const l of target.labels) {
          const label = store.scene.roomLabels[l.id];
          if (label) {
            label.x += delta.x;
            label.y += delta.y;
          }
        }
      });
      return true;
    }

    // 家具の回転
    if (e.key === '[' || e.key === ']') {
      const items = store.selection.filter((s) => s.type === 'furniture');
      if (items.length === 0) return false;
      const sign = e.key === ']' ? 1 : -1;
      const amount = (sign * Math.PI) / (e.shiftKey ? 36 : 4);
      store.commit(() => {
        for (const ref of items) {
          const f = store.scene.furniture[ref.id];
          if (f) f.angle += amount;
        }
      });
      return true;
    }
    return false;
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
    return `${n} 個を選択中 — ドラッグで移動、矢印キーで微調整、[ ] で家具を回転、Delete で削除`;
  }
}

/** 選択から「実際に動かす対象」を展開する。壁を選んだら両端のノードが動く */
function collectMoveTarget(editor: Editor): MoveTarget {
  const scene = editor.store.scene;
  const nodeIds = new Set<Id>();
  const target: MoveTarget = { nodes: [], furniture: [], labels: [], openings: [] };

  for (const ref of editor.store.selection) {
    switch (ref.type) {
      case 'node':
        if (scene.nodes[ref.id]) nodeIds.add(ref.id);
        break;
      case 'wall': {
        const w = scene.walls[ref.id];
        if (w) {
          nodeIds.add(w.a);
          nodeIds.add(w.b);
        }
        break;
      }
      case 'furniture': {
        const f = scene.furniture[ref.id];
        if (f) target.furniture.push({ id: f.id, origin: vec(f.x, f.y) });
        break;
      }
      case 'roomLabel': {
        const l = scene.roomLabels[ref.id];
        if (l) target.labels.push({ id: l.id, origin: vec(l.x, l.y) });
        break;
      }
      case 'opening': {
        const o = scene.openings[ref.id];
        if (o) target.openings.push({ id: o.id, origin: o.offset });
        break;
      }
    }
  }
  for (const id of nodeIds) target.nodes.push({ id, origin: nodePos(scene, id) });
  return target;
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

/** 選択範囲の中心 */
export function selectionCenter(editor: Editor): Vec | null {
  const t = collectMoveTarget(editor);
  const pts = [...t.nodes.map((n) => n.origin), ...t.furniture.map((f) => f.origin), ...t.labels.map((l) => l.origin)];
  if (pts.length === 0) return null;
  const sum = pts.reduce((acc, p) => add(acc, p), vec(0, 0));
  return vec(sum.x / pts.length, sum.y / pts.length);
}

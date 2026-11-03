import { cornerEntities, type CornerKind } from '../core/corner.ts';
import { joinEntities } from '../core/join.ts';
import { isSelectable } from '../core/entity.ts';
import { shapeOutline } from '../core/shapes.ts';
import type { EntityRef } from '../core/types.ts';
import { strokeSegments } from '../render/frame.ts';
import { drawSnapMarker, type Frame } from '../render/renderer.ts';
import { theme } from '../render/theme.ts';
import type { Editor } from '../ui/editor.ts';
import type { OptionField, PointerInfo, Tool } from './tool.ts';
import { wallEnds } from '../core/ops.ts';

/**
 * 角を落とす・丸めるツール。
 *
 * **`ModifyTool` には入れない。** あちらは「1 クリックで完結する無状態」で、
 * 相手は `cutterCurves` が暗黙に集める。角の処理は**どの 2 本かを人が選ぶ**ので
 * 暗黙にできず、点を溜める状態が要る。`TransformTool` と同じ形にしてある。
 *
 * **壁は面取りだけ。角の丸めはできない。** `Wall` が 2 つのノードを結ぶ直線で、
 * 円弧壁がまだ無いので、丸めた円弧を壁として置く先が無い。
 * 黙って変なものを作るより、断って理由を出す。
 */
export class CornerTool implements Tool {
  readonly id = 'corner' as const;
  readonly label = '角';
  readonly shortcut = 'A';
  readonly cursor = 'crosshair';
  readonly group = 'modify' as const;

  /**
   * 何をするか。**どれも「2 つ選ぶ」という操作が同じ**なので 1 つのツールに
   * まとめてある（建具が 11 種別を 2 ツールで出しているのと同じ考え方）。
   */
  kind: CornerKind | 'join' = 'fillet';
  /** 面取りで角から戻る距離 (mm) */
  distance = 300;
  /** 角の丸めの半径 (mm) */
  radius = 300;

  /** 1 本目。2 本目を押した時点で確定する */
  private first: EntityRef | null = null;

  onActivate(editor: Editor): void {
    editor.store.clearSelection();
    this.first = null;
  }

  onDeactivate(): void {
    this.first = null;
  }

  isActive(): boolean {
    return this.first !== null;
  }

  cancel(editor: Editor): void {
    this.first = null;
    editor.requestRender();
  }

  onKeyDown(editor: Editor, e: KeyboardEvent): boolean {
    if (e.key === 'Escape' && this.first) {
      this.cancel(editor);
      return true;
    }
    return false;
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;
    const target = this.pick(editor, p.raw);
    if (!target) return;

    if (!this.first) {
      this.first = target;
      editor.requestRender();
      return;
    }
    if (sameTarget(this.first, target)) return;

    const first = this.first;
    this.first = null;
    editor.store.commit(() =>
      this.kind === 'join'
        ? joinEntities(editor.store.scene, first, target)
        : cornerEntities(editor.store.scene, first, target, {
            kind: this.kind,
            distance: this.distance,
            radius: this.radius,
          }),
    );
    editor.requestRender();
  }

  /** 図形と壁だけを拾う。`ModifyTool` と同じ考え方 */
  private pick(editor: Editor, at: { x: number; y: number }): EntityRef | null {
    const ref = editor.pick(at, editor.pickRadius() * 2);
    if (!ref || (ref.type !== 'shape' && ref.type !== 'wall')) return null;
    return isSelectable(editor.store.scene, ref) ? ref : null;
  }

  options(): OptionField[] {
    return [
      {
        kind: 'select',
        label: '種類',
        value: this.kind,
        options: [
          { value: 'fillet', label: '角の丸め' },
          { value: 'chamfer', label: '面取り' },
          { value: 'join', label: '結合' },
        ],
        onChange: (v) => {
          this.kind = v === 'chamfer' || v === 'join' ? v : 'fillet';
          this.first = null;
        },
      },
      ...(this.kind === 'join'
        ? [{ kind: 'note' as const, text: '端点が合っているものどうしを繋ぎます（伸ばしはしません）' }]
        : []),
      this.kind === 'join'
        ? { kind: 'note', text: '壁は一直線に並んでいるときだけ 1 本になります' }
        : this.kind === 'fillet'
        ? {
            kind: 'number',
            label: '半径',
            value: this.radius,
            step: 50,
            min: 1,
            suffix: 'mm',
            onChange: (v) => void (this.radius = Math.max(1, v)),
          }
        : {
            kind: 'number',
            label: '戻り',
            value: this.distance,
            step: 50,
            min: 1,
            suffix: 'mm',
            onChange: (v) => void (this.distance = Math.max(1, v)),
          },
      ...(this.kind === 'fillet'
        ? [{ kind: 'note' as const, text: '壁は丸められません（円弧の壁がまだありません）' }]
        : []),
    ];
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    const snap = editor.lastSnap;
    if (snap && snap.kind !== 'free') drawSnapMarker(frame, snap.point, snap.label);

    // 1 本目を選んだら、それをなぞって見せる
    const highlight = this.first ?? this.pick(editor, editor.pointerWorld());
    if (!highlight) return;
    const segments = outlineOf(editor, highlight);
    if (segments.length === 0) return;
    const { ctx } = frame;
    ctx.save();
    ctx.strokeStyle = this.first ? theme.preview : 'rgba(37, 99, 235, 0.45)';
    ctx.lineWidth = 3;
    strokeSegments(frame, segments);
    ctx.restore();
  }

  status(editor: Editor): string {
    const what = this.kind === 'join'
      ? '端点で繋ぎます'
      : this.kind === 'fillet'
        ? `半径 ${this.radius}mm で丸めます`
        : `${this.distance}mm 戻して面取りします`;
    if (this.first) return `もう 1 本をクリック（${what}）`;
    return this.pick(editor, editor.pointerWorld())
      ? `1 本目をクリック（${what}）`
      : '角を作る 2 本の、1 本目にカーソルを合わせてクリック';
  }
}

const sameTarget = (a: EntityRef, b: EntityRef): boolean => a.type === b.type && a.id === b.id;

/** なぞる輪郭。当たり判定と同じ折れ線近似 */
function outlineOf(editor: Editor, ref: EntityRef): { a: { x: number; y: number }; b: { x: number; y: number } }[] {
  const scene = editor.store.scene;
  if (ref.type === 'shape') {
    const shape = scene.shapes[ref.id];
    return shape ? shapeOutline(scene, shape) : [];
  }
  const wall = scene.walls[ref.id];
  if (!wall) return [];
  const [a, b] = wallEnds(scene, wall);
  return [{ a, b }];
}

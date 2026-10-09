import type { Vec } from '../core/geometry.ts';
import { resolveLength, type CoordInput } from '../core/coord-input.ts';
import { isSelectable } from '../core/entity.ts';
import { extendShape, extendWall, offsetShape, offsetWall, trimShape, trimWall } from '../core/modify.ts';
import { shapeOutline } from '../core/shapes.ts';
import type { EntityRef } from '../core/types.ts';
import { drawSnapMarker, type Frame } from '../render/renderer.ts';
import { strokeSegments } from '../render/frame.ts';
import { theme } from '../render/theme.ts';
import type { Editor } from '../ui/editor.ts';
import type { NumericEntry, OptionField, PointerInfo, Tool, ToolId } from './tool.ts';

export type ModifyMode = 'offset' | 'trim' | 'extend';

/**
 * オフセット・トリム・延長。
 *
 * 切断要素や境界要素を明示的に選ばせない（AutoCAD のクイックトリムと同じ）。
 * 表示されていてロックされていない図形と壁を、暗黙の相手として総当たりする。
 * 間取り程度の要素数なら十分速く、操作が段違いに軽い。
 */
export class ModifyTool implements Tool {
  readonly id: ToolId;
  readonly label: string;
  readonly shortcut: string;
  readonly cursor = 'crosshair';
  readonly group = 'modify' as const;

  private readonly mode: ModifyMode;
  /** オフセットの距離 (mm) */
  distance = 500;

  constructor(mode: ModifyMode, id: ToolId, label: string, shortcut: string) {
    this.mode = mode;
    this.id = id;
    this.label = label;
    this.shortcut = shortcut;
  }

  onActivate(editor: Editor): void {
    editor.store.clearSelection();
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;
    const target = this.pickTarget(editor, p.raw);
    if (!target) return;

    const store = editor.store;
    store.commit(() => this.apply(editor, target, p.raw));
  }

  private apply(editor: Editor, target: EntityRef, at: Vec): boolean {
    const scene = editor.store.scene;
    switch (this.mode) {
      case 'offset': {
        const created =
          target.type === 'shape'
            ? offsetShape(scene, target.id, this.distance, at)
            : offsetWall(scene, target.id, this.distance, at);
        return created !== null;
      }
      case 'trim':
        return target.type === 'shape' ? trimShape(scene, target.id, at) : trimWall(scene, target.id, at);
      case 'extend':
        return target.type === 'shape' ? extendShape(scene, target.id, at) : extendWall(scene, target.id, at);
    }
  }

  /**
   * 図形と壁だけを拾う。家具や建具は対象外。
   *
   * 掴める距離は通常より広めにとる。オフセットは「どちら側に出すか」を
   * カーソルの位置で決めるので、線のすぐ上を正確にクリックさせると側が定まらない。
   */
  private pickTarget(editor: Editor, at: Vec): EntityRef | null {
    const hit = editor.pick(at, editor.pickRadius() * 4);
    if (!hit) return null;
    if (hit.type !== 'shape' && hit.type !== 'wall') return null;
    if (!isSelectable(editor.store.scene, hit)) return null;
    return hit;
  }

  numericEntry(_editor: Editor): NumericEntry | null {
    if (this.mode !== 'offset') return null;
    return {
      mode: 'length',
      base: null,
      hint: 'オフセットの距離[mm]',
      submit: (ed, input: CoordInput) => {
        const length = resolveLength(input);
        if (length !== null && length > 0) {
          this.distance = length;
          ed.requestRender();
        }
      },
    };
  }

  options(): OptionField[] {
    if (this.mode === 'offset') {
      return [
        {
          kind: 'number',
          label: '距離 (mm)',
          value: this.distance,
          step: 50,
          min: 1,
          onChange: (v) => void (this.distance = Math.max(1, v)),
        },
        { kind: 'note', text: '出したい側をクリック' },
      ];
    }
    return [{ kind: 'note', text: '表示中の図形と壁を相手に、クリックした箇所を処理します' }];
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    const snap = editor.lastSnap;
    if (snap && snap.kind !== 'free') drawSnapMarker(frame, snap.point, snap.label);

    // 対象になる図形を薄く示す
    const target = this.pickTarget(editor, editor.pointerWorld());
    if (!target) return;
    const segments = outlineOf(editor, target);
    if (segments.length === 0) return;

    const { ctx } = frame;
    ctx.save();
    ctx.setLineDash([]);
    ctx.strokeStyle = this.mode === 'trim' ? theme.crossingRectStroke : theme.preview;
    ctx.lineWidth = 3;
    strokeSegments(frame, segments);
    ctx.restore();
  }

  status(editor: Editor): string {
    const target = this.pickTarget(editor, editor.pointerWorld());
    switch (this.mode) {
      case 'offset':
        return target ? `${this.distance}mm 離してコピーします` : '図形か壁にカーソルを合わせ、出したい側をクリック';
      case 'trim':
        return target ? 'クリックした側を落とします' : '切り落としたい部分にカーソルを合わせてクリック';
      case 'extend':
        return target ? '近い方の端を伸ばします' : '伸ばしたい側の端にカーソルを合わせてクリック';
    }
  }
}

/** 対象の輪郭。当たり判定と同じ折れ線近似を使う */
function outlineOf(editor: Editor, ref: EntityRef): { a: Vec; b: Vec }[] {
  const scene = editor.store.scene;
  if (ref.type === 'wall') {
    const wall = scene.walls[ref.id];
    if (!wall) return [];
    const a = scene.nodes[wall.a];
    const b = scene.nodes[wall.b];
    return a && b ? [{ a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } }] : [];
  }
  const shape = scene.shapes[ref.id];
  return shape ? shapeOutline(scene, shape) : [];
}

import { defaultAttrs } from '../core/attrs.ts';
import { resolvePoint, type CoordInput } from '../core/coord-input.ts';
import { dist, dot, mid, norm, perp, sub, type Vec } from '../core/geometry.ts';
import { dimensionPrimitives } from '../core/dimension.ts';
import { getLayer, LAYER_IDS, resolveNewLayer } from '../core/layer.ts';
import type { DimEnd, DimensionShape } from '../core/shapes.ts';
import { newId } from '../core/types.ts';
import { drawPrimitives } from '../render/primitive.ts';
import { drawSnapMarker, type Frame } from '../render/renderer.ts';
import type { Editor } from '../ui/editor.ts';
import { pointerAngleFrom } from './wall.ts';
import type { NumericEntry, OptionField, PointerInfo, Tool } from './tool.ts';

/**
 * 2点間の寸法を置くツール。
 * スナップでノードを掴めたら、その角に紐づける（角を動かすと値が追従する）。
 */
export class DimensionTool implements Tool {
  readonly id = 'dimension' as const;
  readonly label = '寸法';
  readonly shortcut = 'H';
  readonly cursor = 'crosshair';
  readonly group = 'annotate' as const;

  private ends: DimEnd[] = [];

  onActivate(editor: Editor): void {
    editor.store.clearSelection();
    this.reset(editor);
  }

  onDeactivate(editor: Editor): void {
    this.reset(editor);
  }

  isActive(): boolean {
    return this.ends.length > 0;
  }

  cancel(editor: Editor): void {
    this.reset(editor);
    editor.requestRender();
  }

  private reset(editor: Editor): void {
    this.ends = [];
    editor.snapContext = {};
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;

    if (this.ends.length < 2) {
      // スナップでノードを掴めたなら、そこに紐づける
      this.ends.push({ x: p.world.x, y: p.world.y, nodeId: p.snap.nodeId ?? null });
      editor.snapContext = { from: p.world };
      return;
    }

    // 3点目は「どちら側にどれだけ出すか」
    const shape = this.build(editor, p.world);
    this.reset(editor);
    if (!shape) return;
    const store = editor.store;
    store.commit(() => {
      store.scene.shapes[shape.id] = shape;
    });
  }

  onKeyDown(editor: Editor, e: KeyboardEvent): boolean {
    if (e.key === 'Escape' && this.ends.length > 0) {
      this.cancel(editor);
      return true;
    }
    return false;
  }

  private build(editor: Editor, through: Vec): DimensionShape | null {
    const [a, b] = this.ends;
    if (!a || !b) return null;
    const pa = { x: a.x, y: a.y };
    const pb = { x: b.x, y: b.y };
    if (dist(pa, pb) < 1) return null;

    const normal = perp(norm(sub(pb, pa)));
    return {
      id: newId('dim'),
      shape: 'dimension',
      layerId: resolveNewLayer(
        editor.store.scene.layers,
        editor.store.settings.currentLayerId,
        LAYER_IDS.dimension,
      ),
      levelId: editor.store.scene.activeLevelId,
      attrs: defaultAttrs(),
      a,
      b,
      // クリックした点を通るように、法線方向の成分だけ取る
      offset: dot(sub(through, mid(pa, pb)), normal),
      override: null,
    };
  }

  numericEntry(_editor: Editor): NumericEntry | null {
    if (this.ends.length !== 1) return null;
    const from = { x: this.ends[0].x, y: this.ends[0].y };
    return {
      mode: 'point',
      base: from,
      fallbackAngleDeg: (ed) => pointerAngleFrom(ed, from),
      submit: (ed, input) => this.submitSecondEnd(ed, input),
    };
  }

  private submitSecondEnd(editor: Editor, input: CoordInput): void {
    const first = this.ends[0];
    if (!first) return;
    const point = resolvePoint(input, { x: first.x, y: first.y }, pointerAngleFrom(editor, first));
    if (!point) return;
    this.ends.push({ x: point.x, y: point.y, nodeId: null });
    editor.snapContext = { from: point };
    editor.requestRender();
  }

  options(): OptionField[] {
    return [{ kind: 'note', text: '端点を2つ指定し、3点目で寸法線の位置を決めます' }];
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    const snap = editor.lastSnap;
    if (snap && snap.kind !== 'free') drawSnapMarker(frame, snap.point, snap.label);
    if (this.ends.length === 0) return;

    const cursor = snap?.point ?? editor.pointerWorld();
    const preview =
      this.ends.length === 1
        ? this.previewWith(editor, { x: cursor.x, y: cursor.y, nodeId: null })
        : this.build(editor, cursor);
    if (!preview) return;

    const layer = getLayer(editor.store.scene.layers, preview.layerId, LAYER_IDS.dimension);
    drawPrimitives(
      frame,
      dimensionPrimitives(editor.store.scene, preview, editor.store.scene.standard),
      layer,
      'rgba(37, 99, 235, 0.9)',
    );
  }

  /** 2点目を決めている途中のプレビュー。寸法線は計測線の上に重ねる */
  private previewWith(editor: Editor, second: DimEnd): DimensionShape | null {
    const a = this.ends[0];
    if (!a || dist({ x: a.x, y: a.y }, { x: second.x, y: second.y }) < 1) return null;
    return {
      id: '__preview',
      shape: 'dimension',
      layerId: LAYER_IDS.dimension,
      levelId: editor.store.scene.activeLevelId,
      attrs: defaultAttrs(),
      a,
      b: second,
      offset: 0,
      override: null,
    };
  }

  status(): string {
    return ['クリックで1点目', 'クリックで2点目', 'クリックで寸法線を出す位置を指定'][this.ends.length]!;
  }
}

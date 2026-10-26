import { dist, type Vec } from '../core/geometry.ts';
import { LAYER_IDS, resolveNewLayer } from '../core/layer.ts';
import { arcFromPoints, SHAPE_GEOMETRY, type Shape } from '../core/shapes.ts';
import { resolvePoint, type CoordInput } from '../core/coord-input.ts';
import type { TextAlign } from '../core/primitive.ts';
import { JIS_TEXT_HEIGHTS } from '../core/standard.ts';
import { newId } from '../core/types.ts';
import { drawPrimitives } from '../render/primitive.ts';
import { drawSnapMarker, type Frame } from '../render/renderer.ts';
import { getLayer } from '../core/layer.ts';
import type { Editor } from '../ui/editor.ts';
import { pointerAngleFrom } from './wall.ts';
import type { NumericEntry, OptionField, PointerInfo, Tool, ToolId } from './tool.ts';

export type ShapeToolMode = 'line' | 'arc' | 'text' | 'point';

/**
 * 汎用図形の作図ツール。
 * OpeningTool と同じく、1つのクラスをモードでパラメタライズしている。
 * 「何点取るか・どう組むか」はモードごとに下の switch 1箇所に閉じている。
 */
export class ShapeTool implements Tool {
  readonly id: ToolId;
  readonly label: string;
  readonly shortcut: string;
  readonly cursor = 'crosshair';
  readonly group = 'draw' as const;

  private readonly mode: ShapeToolMode;
  /** 確定済みのクリック点 */
  private points: Vec[] = [];

  /** 線モード: 連続して引いてポリラインにする */
  chain = false;
  /** 円モード: 円か円弧か */
  arcMode: 'circle' | 'arc' = 'circle';
  /** 文字モード */
  text = '文字';
  textHeight = 3.5;
  textAlign: TextAlign = 'center';

  constructor(mode: ShapeToolMode, id: ToolId, label: string, shortcut: string) {
    this.mode = mode;
    this.id = id;
    this.label = label;
    this.shortcut = shortcut;
  }

  onActivate(editor: Editor): void {
    editor.store.clearSelection();
    this.reset(editor);
  }

  onDeactivate(editor: Editor): void {
    this.reset(editor);
  }

  isActive(): boolean {
    return this.points.length > 0;
  }

  cancel(editor: Editor): void {
    this.reset(editor);
    editor.requestRender();
  }

  private reset(editor: Editor): void {
    this.points = [];
    editor.snapContext = {};
  }

  /** そのモードが必要とする点の数。線の連続モードだけ可変 */
  private get requiredPoints(): number {
    switch (this.mode) {
      case 'line':
        return this.chain ? Infinity : 2;
      case 'arc':
        return this.arcMode === 'circle' ? 2 : 3;
      case 'text':
      case 'point':
        return 1;
    }
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;
    this.points.push(p.world);
    editor.snapContext = { from: this.points[this.points.length - 1] };
    if (this.points.length >= this.requiredPoints) this.commit(editor);
  }

  onDoubleClick(editor: Editor): void {
    // 連続モードの終了
    if (this.points.length >= 2) this.commit(editor);
    else this.reset(editor);
  }

  onKeyDown(editor: Editor, e: KeyboardEvent): boolean {
    if (e.key === 'Enter' && this.points.length >= 2) {
      this.commit(editor);
      return true;
    }
    if (e.key === 'Escape' && this.points.length > 0) {
      this.cancel(editor);
      return true;
    }
    return false;
  }

  private commit(editor: Editor): void {
    const shape = this.build(editor);
    this.reset(editor);
    if (!shape) return;
    const store = editor.store;
    store.commit(() => {
      store.scene.shapes[shape.id] = shape;
    });
  }

  private build(editor: Editor): Shape | null {
    const pts = this.points;
    const layerId = resolveNewLayer(
      editor.store.scene.layers,
      editor.store.settings.currentLayerId,
      SHAPE_GEOMETRY[shapeKindOf(this.mode, this.arcMode)].defaultLayer,
    );
    const id = newId('s');
    const levelId = editor.store.scene.activeLevelId;

    switch (this.mode) {
      case 'line': {
        const unique = dedupePoints(pts);
        if (unique.length < 2) return null;
        if (unique.length === 2) return { id, shape: 'line', layerId, levelId, a: unique[0], b: unique[1] };
        return { id, shape: 'polyline', layerId, levelId, points: unique, closed: false };
      }
      case 'arc': {
        if (this.arcMode === 'circle') {
          const radius = dist(pts[0], pts[1]);
          return radius < 1 ? null : { id, shape: 'circle', layerId, levelId, center: pts[0], radius };
        }
        if (dist(pts[0], pts[1]) < 1) return null;
        return { id, shape: 'arc', layerId, levelId, ...arcFromPoints(pts[0], pts[1], pts[2]) };
      }
      case 'text': {
        const value = this.text.trim();
        if (!value) return null;
        return {
          id,
          shape: 'text',
          layerId,
          levelId,
          at: pts[0],
          text: value,
          height: this.textHeight,
          angle: 0,
          align: this.textAlign,
        };
      }
      case 'point':
        return { id, shape: 'point', layerId, levelId, at: pts[0] };
    }
  }

  numericEntry(_editor: Editor): NumericEntry | null {
    if (this.mode !== 'line') return null;
    const from = this.points[this.points.length - 1] ?? null;
    return {
      mode: 'point',
      base: from,
      fallbackAngleDeg: (ed) => pointerAngleFrom(ed, from),
      submit: (ed, input) => this.submitNumeric(ed, input),
    };
  }

  private submitNumeric(editor: Editor, input: CoordInput): void {
    const from = this.points[this.points.length - 1] ?? null;
    const point = resolvePoint(input, from, pointerAngleFrom(editor, from));
    if (!point) return;
    this.points.push(point);
    editor.snapContext = { from: point };
    if (this.points.length >= this.requiredPoints) this.commit(editor);
    editor.requestRender();
  }

  options(): OptionField[] {
    switch (this.mode) {
      case 'line':
        return [
          { kind: 'toggle', label: '連続して引く（ポリライン）', value: this.chain, onChange: (v) => void (this.chain = v) },
          { kind: 'note', text: 'Enter / ダブルクリックで終了' },
        ];
      case 'arc':
        return [
          {
            kind: 'select',
            label: '種類',
            value: this.arcMode,
            options: [
              { value: 'circle', label: '円（中心・半径）' },
              { value: 'arc', label: '円弧（中心・始点・終点）' },
            ],
            onChange: (v) => void (this.arcMode = v === 'arc' ? 'arc' : 'circle'),
          },
        ];
      case 'text':
        return [
          { kind: 'text', label: '文字', value: this.text, placeholder: '文字', onChange: (v) => void (this.text = v) },
          {
            kind: 'select',
            label: '高さ',
            value: String(this.textHeight),
            options: JIS_TEXT_HEIGHTS.map((h) => ({ value: String(h), label: `${h} mm` })),
            onChange: (v) => void (this.textHeight = Number(v)),
          },
          {
            kind: 'select',
            label: '揃え',
            value: this.textAlign,
            options: [
              { value: 'left', label: '左' },
              { value: 'center', label: '中央' },
              { value: 'right', label: '右' },
            ],
            onChange: (v) => void (this.textAlign = v as TextAlign),
          },
        ];
      case 'point':
        return [{ kind: 'note', text: 'クリックで基準点を置く' }];
    }
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    const snap = editor.lastSnap;
    if (snap && snap.kind !== 'free') drawSnapMarker(frame, snap.point, snap.label);
    if (this.points.length === 0) return;

    // 確定済みの点 + 現在のカーソル位置で仮の図形を組み、同じ描画経路で出す
    const preview = this.previewShape(editor);
    if (!preview) return;
    const layer = getLayer(editor.store.scene.layers, preview.layerId, LAYER_IDS.shape);
    drawPrimitives(
      frame,
      SHAPE_GEOMETRY[preview.shape].primitives(editor.store.scene, preview as never, editor.store.scene.standard),
      layer,
      'rgba(37, 99, 235, 0.9)',
    );
  }

  private previewShape(editor: Editor): Shape | null {
    const cursor = editor.lastSnap?.point ?? editor.pointerWorld();
    const saved = this.points;
    this.points = [...saved, cursor];
    try {
      // 点が足りないモードはプレビューを出さない
      if (this.points.length < Math.min(this.requiredPoints, this.mode === 'arc' && this.arcMode === 'arc' ? 3 : 2)) {
        return null;
      }
      return this.build(editor);
    } finally {
      this.points = saved;
    }
  }

  status(): string {
    switch (this.mode) {
      case 'line':
        if (this.points.length === 0) return 'クリックで始点を指定';
        return this.chain
          ? 'クリックで次の点 / 数値を打ち込んで Enter / ダブルクリックで終了'
          : 'クリックで終点を指定 / 数値を打ち込んで Enter';
      case 'arc':
        if (this.arcMode === 'circle') {
          return this.points.length === 0 ? 'クリックで円の中心を指定' : 'クリックで半径を指定';
        }
        return ['クリックで円弧の中心を指定', 'クリックで始点を指定', 'クリックで終点を指定（反時計回り）'][
          this.points.length
        ]!;
      case 'text':
        return `「${this.text || '(空)'}」を置く位置をクリック`;
      case 'point':
        return 'クリックで基準点を置く';
    }
  }
}

function shapeKindOf(mode: ShapeToolMode, arcMode: 'circle' | 'arc'): Shape['shape'] {
  if (mode === 'line') return 'line';
  if (mode === 'arc') return arcMode;
  return mode;
}

/** 同じ場所を2回クリックしたときに退化した図形を作らないようにする */
function dedupePoints(points: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const p of points) {
    if (out.length === 0 || dist(out[out.length - 1], p) > 1e-6) out.push(p);
  }
  return out;
}

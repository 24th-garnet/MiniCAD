import { angleOf, dist, sub, toDeg, toRad, type Vec } from '../core/geometry.ts';
import { furniturePolygon, wallOutline, type Segment } from '../core/shape.ts';
import { resolveSelection, isEmptySelection } from '../core/selection.ts';
import { shapeOutline } from '../core/shapes.ts';
import { mirror, rotation, translation, type Transform } from '../core/transform.ts';
import { isNoopTransform, transformEntities } from '../core/transformOps.ts';
import type { EntityRef, Scene } from '../core/types.ts';
import { drawSnapMarker, type Frame } from '../render/renderer.ts';
import { strokeSegments } from '../render/frame.ts';
import { theme } from '../render/theme.ts';
import type { Editor } from '../ui/editor.ts';
import { resolveDelta, resolveLength, type CoordInput } from '../core/coord-input.ts';
import { pointerAngleFrom } from './wall.ts';
import type { NumericEntry, OptionField, PointerInfo, Tool, ToolId } from './tool.ts';

export type TransformMode = 'copy' | 'rotate' | 'mirror';

/** モードごとに何点取るか */
const POINTS_NEEDED: Record<TransformMode, number> = { copy: 2, rotate: 3, mirror: 2 };

/**
 * 選択を複写・回転・鏡像するツール。
 * 変換の中身は core/transformOps.ts にあり、ここは点の取り方と見た目だけを持つ。
 */
export class TransformTool implements Tool {
  readonly id: ToolId;
  readonly label: string;
  readonly shortcut: string;
  readonly cursor = 'crosshair';
  readonly group = 'modify' as const;

  private readonly mode: TransformMode;
  private points: Vec[] = [];
  /** 回転・鏡像で元を残すか。複写は常に残す */
  keepOriginal = false;

  constructor(mode: TransformMode, id: ToolId, label: string, shortcut: string) {
    this.mode = mode;
    this.id = id;
    this.label = label;
    this.shortcut = shortcut;
  }

  onActivate(editor: Editor): void {
    this.points = [];
    editor.snapContext = {};
  }

  onDeactivate(editor: Editor): void {
    this.points = [];
    editor.snapContext = {};
  }

  isActive(): boolean {
    return this.points.length > 0;
  }

  cancel(editor: Editor): void {
    this.points = [];
    editor.snapContext = {};
    editor.requestRender();
  }

  private get copies(): boolean {
    return this.mode === 'copy' || this.keepOriginal;
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;
    if (editor.store.selection.length === 0) return;

    this.points.push(p.world);
    // 1点目は基点。2点目以降は基点からの相対で考えるのでスナップの起点にする
    editor.snapContext = { from: this.points[0] };

    if (this.points.length >= POINTS_NEEDED[this.mode]) this.apply(editor, this.buildTransform(this.points));
  }

  onKeyDown(editor: Editor, e: KeyboardEvent): boolean {
    if (e.key === 'Escape' && this.points.length > 0) {
      this.cancel(editor);
      return true;
    }
    return false;
  }

  /** 取った点から変換を組み立てる。足りない分はカーソル位置で補う */
  private buildTransform(points: Vec[]): Transform | null {
    switch (this.mode) {
      case 'copy': {
        if (points.length < 2) return null;
        return translation(sub(points[1], points[0]));
      }
      case 'rotate': {
        if (points.length < 3) return null;
        const [center, from, to] = points;
        if (dist(center, from) < 1e-6 || dist(center, to) < 1e-6) return null;
        return rotation(center, angleOf(sub(to, center)) - angleOf(sub(from, center)));
      }
      case 'mirror': {
        if (points.length < 2 || dist(points[0], points[1]) < 1e-6) return null;
        return mirror(points[0], points[1]);
      }
    }
  }

  private apply(editor: Editor, t: Transform | null): void {
    const store = editor.store;
    const refs = [...store.selection];
    const base = this.points[0];
    this.points = [];
    editor.snapContext = {};
    if (!t || refs.length === 0) return;

    // 変位も回転もゼロの複写は、同じ場所に二重の壁を作ってしまうので弾く
    if (isNoopTransform(t, base)) return;

    let result: EntityRef[] = [];
    store.commit(() => {
      const r = transformEntities(store.scene, refs, t, { copy: this.copies });
      if (r.refs.length === 0) return false;
      result = r.refs;
    });
    // 複写したら複製側を選択し直す（続けて動かせるように）
    if (result.length > 0) store.setSelection(result);
  }

  numericEntry(editor: Editor): NumericEntry | null {
    if (editor.store.selection.length === 0) return null;
    if (this.mode === 'copy' && this.points.length === 1) {
      const from = this.points[0];
      return {
        mode: 'delta',
        base: from,
        fallbackAngleDeg: (ed) => pointerAngleFrom(ed, from),
        submit: (ed, input) => this.submitCopy(ed, input),
      };
    }
    if (this.mode === 'rotate' && this.points.length === 2) {
      return {
        mode: 'angle',
        base: this.points[0],
        submit: (ed, input) => this.submitRotate(ed, input),
      };
    }
    return null;
  }

  private submitCopy(editor: Editor, input: CoordInput): void {
    const from = this.points[0];
    const delta = resolveDelta(input, from, pointerAngleFrom(editor, from));
    if (!delta) return;
    this.apply(editor, translation(delta));
    editor.requestRender();
  }

  private submitRotate(editor: Editor, input: CoordInput): void {
    const degrees = resolveLength(input);
    if (degrees === null) return;
    this.apply(editor, rotation(this.points[0], toRad(degrees)));
    editor.requestRender();
  }

  options(): OptionField[] {
    if (this.mode === 'copy') {
      return [{ kind: 'note', text: '選択 → 基点 → 配置点。続けて複写できます' }];
    }
    return [
      { kind: 'toggle', label: '元を残す（複写）', value: this.keepOriginal, onChange: (v) => void (this.keepOriginal = v) },
    ];
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    const snap = editor.lastSnap;
    if (snap && snap.kind !== 'free') drawSnapMarker(frame, snap.point, snap.label);
    if (this.points.length === 0) return;

    const { ctx, vp } = frame;
    const cursor = snap?.point ?? editor.pointerWorld();

    // 取った点と基点からの補助線
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = theme.preview;
    ctx.lineWidth = 1.2;
    strokeSegments(frame, [{ a: this.points[this.points.length - 1], b: cursor }]);
    if (this.mode === 'rotate' && this.points.length >= 2) {
      strokeSegments(frame, [{ a: this.points[0], b: this.points[1] }]);
    }
    ctx.setLineDash([]);
    for (const p of this.points) {
      const s = vp.toScreen(p);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = theme.preview;
      ctx.fill();
    }

    // 変換後の姿を薄く出す
    const preview = this.buildTransform([...this.points, cursor]);
    if (preview) {
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.8)';
      ctx.lineWidth = 1.5;
      strokeSegments(frame, previewSegments(editor.store.scene, editor.store.selection, preview, this.copies));
    }

    if (this.mode === 'rotate' && this.points.length >= 2) {
      const angle = toDeg(angleOf(sub(cursor, this.points[0])) - angleOf(sub(this.points[1], this.points[0])));
      const s = vp.toScreen(this.points[0]);
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillStyle = theme.preview;
      ctx.textAlign = 'left';
      ctx.fillText(`${angle.toFixed(1)}°`, s.x + 10, s.y - 10);
    }
    ctx.restore();
  }

  status(editor: Editor): string {
    if (editor.store.selection.length === 0) return 'まず選択ツール（V）で対象を選んでください';
    const taken = this.points.length;
    switch (this.mode) {
      case 'copy':
        return taken === 0 ? 'クリックで基点を指定' : 'クリックで配置点を指定 / 数値を打ち込んで Enter';
      case 'rotate':
        return ['クリックで回転の中心を指定', 'クリックで基準の方向を指定', '回転先をクリック / 角度を打ち込んで Enter'][
          taken
        ]!;
      case 'mirror':
        return taken === 0 ? 'クリックで対称軸の1点目' : 'クリックで対称軸の2点目';
    }
  }
}

/**
 * 変換後の姿を線分で返す。
 * シーンを丸ごと複製して変換を当て、結果の輪郭を引くのが一番安上がりで、
 * 本番と同じ経路を通るぶん見た目のズレも起きない。
 */
function previewSegments(scene: Scene, refs: EntityRef[], t: Transform, copy: boolean): Segment[] {
  const sel = resolveSelection(scene, refs);
  if (isEmptySelection(sel)) return [];

  const draft = structuredClone(scene);
  const result = transformEntities(draft, refs, t, { copy });
  const targets = copy ? result.refs : refs;

  const segments: Segment[] = [];
  for (const ref of targets) {
    switch (ref.type) {
      case 'wall': {
        const wall = draft.walls[ref.id];
        if (wall) segments.push(...wallOutline(draft, wall));
        break;
      }
      case 'furniture': {
        const f = draft.furniture[ref.id];
        if (!f) break;
        const corners = furniturePolygon(f);
        for (let i = 0; i < corners.length; i++) {
          segments.push({ a: corners[i], b: corners[(i + 1) % corners.length] });
        }
        break;
      }
      case 'shape': {
        const s = draft.shapes[ref.id];
        if (s) segments.push(...shapeOutline(draft, s));
        break;
      }
      default:
        break;
    }
  }
  // 移動モードでは壁がノード経由で動くので、選択に壁が無くても輪郭を拾い直す
  if (!copy) {
    for (const id of sel.nodeIds) {
      for (const wall of Object.values(draft.walls)) {
        if ((wall.a === id || wall.b === id) && !targets.some((r) => r.type === 'wall' && r.id === wall.id)) {
          segments.push(...wallOutline(draft, wall));
        }
      }
    }
  }
  return segments;
}

import type { Vec } from '../core/geometry.ts';
import { splitWall } from '../core/ops.ts';
import {
  editableVertices, insertVertex, moveVertex, pickEdge, pickVertex, removeVertex,
} from '../core/vertexOps.ts';
import type { Id, Scene } from '../core/types.ts';
import { drawSnapMarker, type Frame } from '../render/renderer.ts';
import { theme } from '../render/theme.ts';
import type { Editor } from '../ui/editor.ts';
import type { OptionField, PointerInfo, Tool } from './tool.ts';

/**
 * 頂点の編集（ワイヤーの「変形」）。
 *
 * **壁の角は新しく書かない。** ノード（`Node`）のピック・スナップ・ハンドル
 * 描画・ドラッグ・統合・分割は全部あって、選択ツールで既に動く。
 * このツールが足すのは
 *
 * - **図形の頂点**を掴んで動かす（線とポリラインだけ）
 * - 辺の上をダブルクリックして**頂点を足す**
 * - 頂点を選んで Delete で**落とす**
 * - 壁の途中をクリックして**角を増やす**（`splitWall` を呼ぶだけ）
 *
 * `SelectTool` の第 5 状態にせず別ツールにしたのは、選択ツールが
 * 「掴んで動かす」ものを 1 つ増やすと、**実体を動かすつもりが頂点を
 * 動かしていた**という取り違えが起きるため。
 */
export class VertexTool implements Tool {
  readonly id = 'vertex' as const;
  readonly label = '変形';
  readonly shortcut = 'Z';
  readonly cursor = 'crosshair';
  readonly group = 'modify' as const;

  /**
   * ドラッグ中の頂点と、掴んだ時点のシーン。
   *
   * **控えを取ってから動かす。** ドラッグ中は `update`（履歴に残さない）で
   * 動かして見せ、離したときに控えから `commitFrom` する。
   * そうしないと履歴の「前」が動いたあとの状態になり、undo が効かない。
   */
  private drag: { shapeId: Id; index: number; before: Scene } | null = null;
  /** 最後に掴んだ頂点。Delete の相手 */
  private picked: { shapeId: Id; index: number } | null = null;

  onActivate(editor: Editor): void {
    editor.store.clearSelection();
    this.reset(editor);
  }

  onDeactivate(editor: Editor): void {
    this.reset(editor);
  }

  isActive(): boolean {
    return this.drag !== null;
  }

  cancel(editor: Editor): void {
    this.reset(editor);
    editor.requestRender();
  }

  private reset(editor: Editor): void {
    this.drag = null;
    editor.snapContext = {};
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;
    const tol = editor.pickRadius();

    const vertex = pickVertex(editor.store.scene, p.raw, tol);
    if (vertex) {
      this.drag = { ...vertex, before: structuredClone(editor.store.scene) };
      this.picked = vertex;
      // **自分自身に吸い付かせない。** 動かす頂点のすぐ隣に
      // その図形のスナップ点があるので、外さないと動かなくなる
      editor.snapContext = { excludeShapes: [vertex.shapeId] };
      editor.requestRender();
      return;
    }

    // 壁の途中をクリックしたら角を増やす。`splitWall` が開口も拘束も見る
    const ref = editor.pick(p.raw, tol);
    if (ref?.type === 'wall') {
      editor.store.commit(() => splitWall(editor.store.scene, ref.id, p.world) !== null);
      editor.requestRender();
    }
  }

  onPointerMove(editor: Editor, p: PointerInfo): void {
    if (!this.drag) return;
    // ドラッグ中は仮に動かして見せる（確定は離したとき）
    this.apply(editor, p.world, true);
  }

  onPointerUp(editor: Editor, p: PointerInfo): void {
    const moved = this.drag;
    if (!moved) return;
    editor.snapContext = {};
    // 最後の位置まで動かしてから、掴んだ時点の控えを「前」として確定する
    this.apply(editor, p.world, false);
    this.drag = null;
    this.picked = { shapeId: moved.shapeId, index: moved.index };
    editor.store.commitFrom(moved.before);
    editor.requestRender();
  }

  /** ドラッグ中の仮表示。履歴には残さない（確定は `commitFrom`） */
  private apply(editor: Editor, to: Vec, render: boolean): void {
    const target = this.drag ?? this.picked;
    if (!target) return;
    editor.store.update(() => {
      const scene = editor.store.scene;
      const shape = scene.shapes[target.shapeId];
      if (!shape) return;
      const next = moveVertex(shape, target.index, to);
      if (next) scene.shapes[target.shapeId] = next;
    });
    if (render) editor.requestRender();
  }

  onDoubleClick(editor: Editor, p: PointerInfo): void {
    const edge = pickEdge(editor.store.scene, p.raw, editor.pickRadius());
    if (!edge) return;
    editor.store.commit(() => {
      const scene = editor.store.scene;
      const shape = scene.shapes[edge.shapeId];
      if (!shape) return false;
      const next = insertVertex(shape, edge.edgeIndex, p.world);
      if (!next) return false;
      scene.shapes[edge.shapeId] = next;
      return true;
    });
    this.picked = { shapeId: edge.shapeId, index: edge.edgeIndex + 1 };
    editor.requestRender();
  }

  onKeyDown(editor: Editor, e: KeyboardEvent): boolean {
    if (e.key === 'Escape' && this.drag) {
      this.cancel(editor);
      return true;
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return false;
    const target = this.picked;
    if (!target) return false;
    editor.store.commit(() => {
      const scene = editor.store.scene;
      const shape = scene.shapes[target.shapeId];
      if (!shape) return false;
      const next = removeVertex(shape, target.index);
      if (!next) return false;
      scene.shapes[target.shapeId] = next;
      return true;
    });
    this.picked = null;
    editor.requestRender();
    return true;
  }

  options(): OptionField[] {
    return [
      { kind: 'note', text: '頂点をドラッグ / 辺をダブルクリックで追加 / Delete で削除' },
      { kind: 'note', text: '壁は途中をクリックすると角が増えます（角はそのまま掴めます）' },
    ];
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    const snap = editor.lastSnap;
    if (snap && snap.kind !== 'free') drawSnapMarker(frame, snap.point, snap.label);

    const { ctx, vp } = frame;
    const hover = this.drag ?? pickVertex(editor.store.scene, editor.pointerWorld(), editor.pickRadius());
    ctx.save();
    // 図形の頂点にハンドルを出す。壁のノードは renderer が既に描いている
    for (const shape of Object.values(editor.store.scene.shapes)) {
      const layer = editor.store.scene.layers[shape.layerId];
      if (layer && (!layer.visible || layer.locked)) continue;
      editableVertices(shape).forEach((v, i) => {
        const s = vp.toScreen(v);
        const on = hover?.shapeId === shape.id && hover.index === i;
        ctx.beginPath();
        ctx.rect(s.x - 4, s.y - 4, 8, 8);
        ctx.fillStyle = on ? theme.preview : '#ffffff';
        ctx.fill();
        ctx.strokeStyle = on ? theme.preview : 'rgba(37, 99, 235, 0.8)';
        ctx.lineWidth = on ? 2 : 1;
        ctx.stroke();
      });
    }
    ctx.restore();
  }

  status(editor: Editor): string {
    if (this.drag) return '離したところへ頂点を動かします';
    const tol = editor.pickRadius();
    if (pickVertex(editor.store.scene, editor.pointerWorld(), tol)) {
      return 'ドラッグで動かす / Delete で落とす';
    }
    if (pickEdge(editor.store.scene, editor.pointerWorld(), tol)) {
      return 'ダブルクリックで頂点を足す';
    }
    const ref = editor.pick(editor.pointerWorld(), tol);
    if (ref?.type === 'wall') return 'クリックで壁に角を増やす';
    return '頂点をドラッグ / 辺をダブルクリックで追加 / 壁はクリックで角を増やす';
  }
}

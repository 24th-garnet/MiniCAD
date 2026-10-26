import { sceneBounds } from '../core/entity.ts';
import { activeLevel } from '../core/level.ts';
import type { Editor } from '../ui/editor.ts';
import { defaultCamera, dolly, frameAll, orbit, pan, type Camera3D } from './camera.ts';
import { highlightOf, pickEntity, Select3D, type Pointer3D } from './interact.ts';
import { buildMesh, type Face3 } from './mesh.ts';
import { paint } from './paint.ts';
import { screenRay } from './ray.ts';

/**
 * 3D ビュー。2D とは**別のキャンバス**に描く。
 *
 * 1枚を共有しない理由は `Editor.observeResize` にある。あそこは
 * 裏バッファの大きさ・DPR・`Viewport` のサイズを一体で管理していて、
 * MiniCAD でいちばん壊れやすい15行。ここに 3D の分岐を入れたくない。
 * 2枚にすれば `Editor` 側の変更は `get revision()` の1行だけで済む。
 *
 * メッシュはシーンの版で持ち、カメラを動かしても作り直さない。
 * `buildMesh` が `Camera3D` を引数に取らないので、取り違えはコンパイルで止まる。
 *
 * **ポインタはカメラと選択に振り分ける。** 素の左ドラッグは今まで通り回転で、
 * 動かさずに離したときだけクリックとして `Select3D` に回す。
 * 「ドラッグで回す」は 3D の基本操作なので、修飾キー送りにはしない。
 */
/** 拾うときの near。`camera.ts` の NEAR と揃える */
const NEAR_PICK = 50;

/** これ以内の動きはクリック扱い。2D の `SelectTool` と同じ考え方 */
const CLICK_SLOP = 4;

export class Viewer3D {
  readonly camera: Camera3D = defaultCamera();
  showEdges = false;

  private readonly ctx: CanvasRenderingContext2D;
  private meshCache: Face3[] | null = null;
  private cachedRevision = -1;
  private frameRequested = false;
  private visible = false;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private shownOnce = false;
  private dragging: 'orbit' | 'pan' | null = null;
  private last = { x: 0, y: 0 };
  private readonly select = new Select3D();
  private downAt = { x: 0, y: 0 };
  private moved = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly editor: Editor,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D コンテキストを取得できませんでした');
    this.ctx = ctx;
    this.attachEvents();
    this.observeResize();
    editor.onChange(() => this.requestRender());
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.canvas.hidden = !visible;
    if (!visible) return;
    this.measure();
    // 初めて開いたときだけ全体に合わせる。以後はユーザーのカメラを保つ
    if (!this.shownOnce) {
      this.shownOnce = true;
      this.fit();
    }
    this.requestRender();
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** 図面全体が入るようにカメラを合わせる */
  fit(): void {
    const scene = this.editor.store.scene;
    frameAll(this.camera, sceneBounds(scene), activeLevel(scene).wallHeight);
    this.requestRender();
  }

  requestRender(): void {
    // 隠れているときは何もしない。パネルの refresh から毎回呼ばれても無駄にならないように
    if (!this.visible || this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.draw();
    });
  }

  private get mesh(): Face3[] {
    const revision = this.editor.revision;
    if (this.meshCache === null || this.cachedRevision !== revision) {
      this.meshCache = buildMesh(this.editor.store.scene, this.editor.rooms);
      this.cachedRevision = revision;
    }
    return this.meshCache;
  }

  private draw(): void {
    paint(this.ctx, this.camera, this.mesh, this.width, this.height, {
      showEdges: this.showEdges,
      dpr: this.dpr,
      tint: highlightOf(this.editor),
    });
  }

  /** いまの状態の説明。ステータスバーが 3D のときに読む */
  status(): string {
    return this.select.status(this.editor);
  }

  /**
   * ポインタの位置から 3D のポインタ情報を作る。
   *
   * **CSS ピクセルで渡す。** `paint` は座標に DPR を掛けるが、
   * `getBoundingClientRect()` 由来の値は掛ける前のもの。
   */
  private pointer(e: PointerEvent): Pointer3D {
    const rect = this.canvas.getBoundingClientRect();
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const ray = screenRay(this.camera, screen.x, screen.y, this.width, this.height);
    return {
      screen,
      ray,
      hit: pickEntity(this.editor, ray, this.mesh, NEAR_PICK),
      shift: e.shiftKey,
      alt: e.altKey,
      meta: e.metaKey || e.ctrlKey,
      button: e.button,
    };
  }

  private measure(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    // 2D 側と同じ作法。ただし ctx.setTransform は使わず、座標に DPR を掛ける
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
  }

  private observeResize(): void {
    const apply = () => {
      if (!this.visible) return;
      this.measure();
      this.requestRender();
    };
    new ResizeObserver(apply).observe(this.canvas);
  }

  private attachEvents(): void {
    const canvas = this.canvas;
    canvas.style.touchAction = 'none';

    // **カメラか選択かは、動かしたかどうかで決める。**
    // 素の左ドラッグは今まで通り回転。動かさずに離したときだけ選択に回る。
    // 「ドラッグで回す」は 3D の基本操作なので、修飾キー送りにはしない。
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      this.last = { x: e.clientX, y: e.clientY };
      this.downAt = { x: e.clientX, y: e.clientY };
      this.moved = false;
      this.dragging = e.button === 1 || e.shiftKey ? 'pan' : 'orbit';
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) {
        this.select.onPointerMove(this.editor, this.pointer(e));
        this.requestRender();
        return;
      }
      if (!this.moved && Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > CLICK_SLOP) {
        this.moved = true;
      }
      const dx = e.clientX - this.last.x;
      const dy = e.clientY - this.last.y;
      this.last = { x: e.clientX, y: e.clientY };
      if (this.dragging === 'pan') pan(this.camera, dx, dy, this.height);
      else orbit(this.camera, dx, dy);
      this.requestRender();
    });

    canvas.addEventListener('pointerleave', () => {
      this.select.onPointerLeave(this.editor);
      this.requestRender();
    });

    canvas.addEventListener('pointerup', (e) => {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      const wasOrbit = this.dragging === 'orbit';
      this.dragging = null;
      // 動かさずに離した素の左＝クリック
      if (wasOrbit && !this.moved && e.button === 0 && !e.shiftKey) {
        this.select.onPointerDown(this.editor, this.pointer(e));
      }
      this.moved = false;
    });

    canvas.addEventListener('pointercancel', (e) => {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      this.dragging = null;
      this.moved = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // 2D と同じ係数。トラックパッドの手触りを揃える
        const intensity = e.ctrlKey ? 0.01 : 0.0015;
        dolly(this.camera, Math.exp(-e.deltaY * intensity));
        this.requestRender();
      },
      { passive: false },
    );
  }
}

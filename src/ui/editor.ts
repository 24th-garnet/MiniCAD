import { dist, sub, vec, type Vec } from '../core/geometry.ts';
import { sceneBounds } from '../core/entity.ts';
import { sheetGeometry } from '../core/sheet.ts';
import { pickAt } from '../core/pick.ts';
import { detectRooms } from '../core/rooms.ts';
import { snapPoint, type SnapResult } from '../core/snap.ts';
import { Store } from '../core/store.ts';
import type { EntityRef, Room } from '../core/types.ts';
import { refKey, render, type Frame } from '../render/renderer.ts';
import { Viewport } from '../render/viewport.ts';
import type { PointerInfo, Tool, ToolId } from '../tools/tool.ts';

/** スナップとピックの判定半径 (px) */
const SNAP_RADIUS_PX = 14;
const PICK_RADIUS_PX = 8;

export interface SnapContext {
  from?: Vec | null;
  excludeNodes?: string[];
  excludeWalls?: string[];
}

export class Editor {
  readonly store = new Store();
  readonly viewport = new Viewport();
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  private tools = new Map<ToolId, Tool>();
  activeToolId: ToolId = 'select';

  hover: EntityRef | null = null;
  lastSnap: SnapResult | null = null;
  lastPointer: Vec = vec(0, 0);

  /** ツールがスナップ対象の絞り込みを指定する場所 */
  snapContext: SnapContext = {};

  private resizeObserver: ResizeObserver | null = null;

  private roomsCache: Room[] | null = null;
  private cachedRevision = -1;

  private frameRequested = false;
  private panning = false;
  private panStart: Vec = vec(0, 0);
  private spaceDown = false;
  private changeListeners = new Set<() => void>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D コンテキストを取得できませんでした');
    this.ctx = ctx;

    this.store.subscribe(() => {
      this.requestRender();
      for (const fn of this.changeListeners) fn();
    });

    this.attachEvents();
    this.observeResize();
  }

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  /**
   * シーンを直に書き換えたあとの通知。版が上がるので、派生データが作り直される。
   *
   * 選択や表示設定だけを変えたときはこれを呼ばない（`notifyUi`）。
   * 呼ぶと**クリックのたびに部屋検出と 3D のメッシュを組み直す**ことになる。
   */
  notifyChanged(): void {
    this.store.touchScene();
  }

  /**
   * シーンは変わっていないが UI の表示だけ更新したいとき。
   * 計測ツールのようにストアを触らないツールでも、ステータスや数値入力欄が追従する。
   */
  notifyUi(): void {
    for (const fn of this.changeListeners) fn();
  }

  // --- ツール ---

  registerTool(tool: Tool): void {
    this.tools.set(tool.id, tool);
  }

  /**
   * 使えるツールを丸ごと入れ替える。モードの切り替えで呼ぶ。
   *
   * **隠したツールは登録そのものから外す。** 表示だけ消すと、ショートカットでは
   * 選べてしまい、ショートカット一覧にも出続ける。登録から外せば、ツールバーも
   * キーマップも一覧も `allTools()` を見ているので、どれも直さずに揃う。
   *
   * 作図の途中なら取り消してから入れ替える。選んでいたツールが消えたときは
   * 選択ツールに戻す。
   */
  setTools(tools: Tool[]): void {
    this.tool.cancel?.(this);
    this.tool.onDeactivate?.(this);
    this.tools.clear();
    for (const tool of tools) this.tools.set(tool.id, tool);
    if (!this.tools.has(this.activeToolId)) this.activeToolId = 'select';
    this.snapContext = {};
    this.tool.onActivate?.(this);
    this.canvas.style.cursor = this.tool.cursor;
    this.requestRender();
    for (const fn of this.changeListeners) fn();
  }

  get tool(): Tool {
    const t = this.tools.get(this.activeToolId);
    if (!t) throw new Error(`未登録のツール: ${this.activeToolId}`);
    return t;
  }

  allTools(): Tool[] {
    return [...this.tools.values()];
  }

  setTool(id: ToolId): void {
    if (this.activeToolId === id) return;
    this.tool.onDeactivate?.(this);
    this.activeToolId = id;
    this.snapContext = {};
    this.tool.onActivate?.(this);
    this.canvas.style.cursor = this.tool.cursor;
    this.requestRender();
    for (const fn of this.changeListeners) fn();
  }

  // --- 部屋の自動検出（シーンが変わったときだけ再計算）---

  /** シーンの版。派生データをキャッシュする側が、作り直す判断に使う */
  get revision(): number {
    return this.store.sceneVersion;
  }

  get rooms(): Room[] {
    if (this.roomsCache === null || this.cachedRevision !== this.revision) {
      this.roomsCache = detectRooms(this.store.scene);
      this.cachedRevision = this.revision;
    }
    return this.roomsCache;
  }

  // --- 座標とスナップ ---

  screenOf(e: { clientX: number; clientY: number }): Vec {
    const rect = this.canvas.getBoundingClientRect();
    return vec(e.clientX - rect.left, e.clientY - rect.top);
  }

  snapAt(world: Vec): SnapResult {
    return snapPoint(this.store.scene, this.store.settings, world, {
      from: this.snapContext.from ?? null,
      excludeNodes: this.snapContext.excludeNodes ?? [],
      excludeWalls: this.snapContext.excludeWalls ?? [],
      radius: this.viewport.toWorldLength(SNAP_RADIUS_PX),
    });
  }

  pickRadius(): number {
    return this.viewport.toWorldLength(PICK_RADIUS_PX);
  }

  pick(world: Vec, tolerance = this.pickRadius()): EntityRef | null {
    return pickAt(this.store.scene, world, tolerance);
  }

  // --- 描画 ---

  requestRender(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.draw();
    });
  }

  private draw(): void {
    const selected = new Set(this.store.selection.map(refKey));
    const frame: Frame = {
      ctx: this.ctx,
      vp: this.viewport,
      scene: this.store.scene,
      rooms: this.rooms,
      settings: this.store.settings,
      selected,
      hover: this.hover,
      violated: new Set(this.store.lastSolve?.violated ?? []),
    };
    render(frame, (f) => this.tool.drawOverlay?.(this, f));
  }

  // --- サイズ調整 ---

  private observeResize(): void {
    const apply = () => {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
      this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const first = this.viewport.width === 0;
      this.viewport.resize(rect.width, rect.height);
      if (first) this.zoomToFit();
      this.requestRender();
    };
    this.resizeObserver = new ResizeObserver(apply);
    this.resizeObserver.observe(this.canvas);
    apply();
  }

  /**
   * 片付ける。埋め込み先から外されたときに呼ばれる。
   *
   * キャンバスに付けた listener はキャンバスごと捨てられるので触らない。
   * **残るのは `ResizeObserver` だけ** — 観測対象が DOM から外れても
   * 自分からは止まらない。
   */
  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.changeListeners.clear();
  }

  zoomToFit(): void {
    const bounds = sceneBounds(this.store.scene);
    if (!bounds) {
      this.viewport.scale = 0.06;
      this.viewport.origin = vec(this.viewport.width / 2, this.viewport.height / 2);
    } else {
      this.viewport.fit(bounds);
    }
    this.requestRender();
  }

  /** 用紙全体が見えるように合わせる。枠を出していなければ図面全体に合わせる */
  zoomToSheet(): void {
    const scene = this.store.scene;
    if (!scene.sheet.show) {
      this.zoomToFit();
      return;
    }
    this.viewport.fit(sheetGeometry(scene.sheet, scene.standard).paper);
    this.requestRender();
  }

  // --- 入力 ---

  private pointerInfo(e: PointerEvent | MouseEvent): PointerInfo {
    const screen = this.screenOf(e);
    const raw = this.viewport.toWorld(screen);
    const snap = this.snapAt(raw);
    this.lastSnap = snap;
    this.lastPointer = screen;
    return {
      screen,
      raw,
      world: snap.point,
      snap,
      shift: e.shiftKey,
      alt: e.altKey,
      meta: e.metaKey || e.ctrlKey,
      button: 'button' in e ? e.button : 0,
    };
  }

  private attachEvents(): void {
    const canvas = this.canvas;
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (e) => {
      canvas.focus();
      // 中ボタン or スペース押下中 or 右ボタンは画面移動
      if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
        this.panning = true;
        this.panStart = this.screenOf(e);
        canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      if (e.button === 2) return;
      canvas.setPointerCapture(e.pointerId);
      this.tool.onPointerDown?.(this, this.pointerInfo(e));
      this.notifyUi();
      this.requestRender();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (this.panning) {
        const s = this.screenOf(e);
        const d = sub(s, this.panStart);
        this.viewport.panBy(d.x, d.y);
        this.panStart = s;
        this.requestRender();
        return;
      }
      const info = this.pointerInfo(e);
      const nextHover = this.activeToolId === 'select' ? this.pick(info.raw) : null;
      const hoverChanged =
        (nextHover?.id ?? null) !== (this.hover?.id ?? null) || (nextHover?.type ?? null) !== (this.hover?.type ?? null);
      this.hover = nextHover;
      this.tool.onPointerMove?.(this, info);
      if (hoverChanged) for (const fn of this.changeListeners) fn();
      this.requestRender();
    });

    const endPointer = (e: PointerEvent) => {
      if (this.panning) {
        this.panning = false;
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        return;
      }
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      this.tool.onPointerUp?.(this, this.pointerInfo(e));
      this.notifyUi();
      this.requestRender();
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    canvas.addEventListener('dblclick', (e) => {
      this.tool.onDoubleClick?.(this, this.pointerInfo(e));
      this.notifyUi();
      this.requestRender();
    });

    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.tool.isActive?.(this)) {
        this.tool.cancel?.(this);
        this.notifyUi();
        this.requestRender();
      }
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const anchor = this.screenOf(e);
        // トラックパッドのピンチは ctrlKey 付きで来るので感度を分ける
        const intensity = e.ctrlKey ? 0.01 : 0.0015;
        const factor = Math.exp(-e.deltaY * intensity);
        this.viewport.zoomAt(anchor, factor);
        this.requestRender();
        for (const fn of this.changeListeners) fn();
      },
      { passive: false },
    );

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTextInput(e.target)) {
        this.spaceDown = true;
        this.canvas.style.cursor = 'grab';
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        this.canvas.style.cursor = this.tool.cursor;
      }
    });
  }

  /** ツールのプレビューで使う、直前のマウス位置のワールド座標 */
  pointerWorld(): Vec {
    return this.viewport.toWorld(this.lastPointer);
  }

  /** 2点が「同じ場所のクリック」とみなせるか（クリックとドラッグの判別） */
  isSameSpot(a: Vec, b: Vec): boolean {
    return dist(a, b) <= this.viewport.toWorldLength(4);
  }
}

export function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

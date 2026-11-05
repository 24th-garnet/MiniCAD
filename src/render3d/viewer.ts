import { refsBounds, sceneBounds } from "../core/entity.ts";
import { activeLevel, levelOf, wallHeightOf } from "../core/level.ts";
import type { Editor } from "../ui/editor.ts";
import {
  applyCameraParams,
  cameraBasis,
  cameraParams,
  defaultCamera,
  dolly,
  flyOver,
  frameAll,
  lookAt,
  type OrbitCenter,
  orbit,
  pan,
  projectPoint,
  viewProjection,
  type Camera3D,
  type CameraParams,
  type View,
} from "./camera.ts";
import {
  highlightOf,
  isWallTop,
  pickEntity,
  Select3D,
  type Pointer3D,
  type Tool3D,
} from "./interact.ts";
import { Place3D } from "./place3d.ts";
import { Measure3D, measurementFaces } from "./measure3d.ts";
import { getLayer, LAYER_IDS } from "../core/layer.ts";
import { distanceOf } from "../core/annotation.ts";
import { type Face3 } from "./mesh.ts";
import { buildBsp, bspOrder, type BspNode } from "./bsp.ts";
import { MeshCache } from "./meshCache.ts";
import { paint } from "./paint.ts";
import { COMMENT_BADGE_R } from "../render/renderer.ts";
import { theme } from "../render/theme.ts";
import type { CommentAnchor } from "../core/annotation.ts";
import { vec3, type Vec3 } from "./mat4.ts";
import type { Vec } from "../core/geometry.ts";
import { screenRay } from "./ray.ts";

/**
 * 3D ビュー。2D とは**別のキャンバス**に描く。
 *
 * 1枚を共有しない理由は `Editor.observeResize` にある。あそこは
 * 裏バッファの大きさ・DPR・`Viewport` のサイズを一体で管理していて、
 * MiniCAD でいちばん壊れやすい15行。ここに 3D の分岐を入れたくない。
 * 2枚にすれば `Editor` 側の変更は `get revision()` の1行だけで済む。
 *
 * **その判断が、分割表示で初めて本当に効いた。** 2D と 3D を左右に並べるのは
 * `.canvas-wrap` に CSS のクラスを 1 つ足すだけで済んでいる。どちらのキャンバスも
 * 自分の `ResizeObserver` を持っているので、親の列が変われば自分で測り直す。
 * **どちらの `observeResize` にも 1 行も触っていない。**
 *
 * **どのビューを出しているかは、ここではなく `ui/view-state.ts` が持つ。**
 * `visible` は「3D が見えているか」しか答えられず、分割では 2D も同時に見えている。
 * ここに残っているのは描画を止めるためのフラグで、権威ではない。
 *
 * メッシュは**実体ごとに**持ち、変わったものだけ作り直す（`MeshCache`）。
 * カメラを動かしても作り直さない——`buildMesh` が `Camera3D` を引数に取らないので、
 * 取り違えはコンパイルで止まる。
 *
 * **ポインタはカメラと選択に振り分ける。** 素の左ドラッグは今まで通り回転で、
 * 動かさずに離したときだけクリックとして `Select3D` に回す。
 * 「ドラッグで回す」は 3D の基本操作なので、修飾キー送りにはしない。
 */
/** 面の顔ぶれが変わっていないか。`MeshCache` が使い回した配列をそのまま比べる */
function sameFaces(a: readonly Face3[], b: readonly Face3[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 拾うときの near。`camera.ts` の NEAR と揃える */
const NEAR_PICK = 50;

/** これ以内の動きはクリック扱い。2D の `SelectTool` と同じ考え方 */
const CLICK_SLOP = 4;

export class Viewer3D {
  readonly camera: Camera3D = defaultCamera();
  /**
   * 回す中心の取り方（ワイヤー 5 枚目の「各種中心モード」）。
   * **カメラだけの話で、メッシュにもピックにも触らない。**
   */
  orbitCenter: OrbitCenter = "all";
  showEdges = false;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly meshCache = new MeshCache();
  private frameRequested = false;
  private visible = false;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private shownOnce = false;
  private dragging: "orbit" | "pan" | null = null;
  private last = { x: 0, y: 0 };
  private readonly select = new Select3D();
  /** ソリッドを 3D の中に置く道具。選択と入れ替えて使う */
  readonly place = new Place3D();
  /** 3D の中で 2 点間を測る道具。測った結果は 2D の計測と同じ実体になる */
  readonly measure = new Measure3D();
  /**
   * いま効いている 3D の道具。**ツールバーには出ない。**
   * 2D の `ToolId` とは別の、3D のビュータブから選ぶ小さな union
   */
  private tool: Tool3D = this.select;
  private downAt = { x: 0, y: 0 };
  private moved = false;
  private resizeObserver: ResizeObserver | null = null;
  private readonly teardown = new AbortController();

  /**
   * 素材の ref から表示色を引く表。**ホストが渡した表示ヒントだけ。**
   * 素材そのものの意味は MiniCAD は知らない
   */
  private materials: ReadonlyMap<string, string> = new Map();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly editor: Editor,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D コンテキストを取得できませんでした");
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
    this.measureCanvas();
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

  /**
   * いま見えている絵を PNG にする。**保存はホスト。**
   *
   * 裏バッファをそのまま出すので、画面に出ているのと同じ画素数になる。
   * 描き終わるのを待ってから取る——`requestAnimationFrame` で描いているので、
   * 直前の編集がまだ乗っていないことがある。
   */
  async capture(): Promise<Blob | null> {
    this.draw();
    return new Promise((resolve) =>
      this.canvas.toBlob((b) => resolve(b), "image/png"),
    );
  }

  /** カメラの引数。ウォークスルーと AI パースへはこの形で渡す */
  get cameraParams(): CameraParams {
    return cameraParams(this.camera);
  }

  setCameraParams(p: Partial<CameraParams>): void {
    applyCameraParams(this.camera, p);
    this.requestRender();
  }

  /** コメントのバッジを叩いたときの通知。`App` が差し込む */
  onCommentOpen: ((id: string) => void) | null = null;

  /** ホストのカタログから表示色を取り込む。渡されなければ既定の 5 色のまま */
  setMaterialColors(colors: ReadonlyMap<string, string>): void {
    this.materials = colors;
    this.requestRender();
  }

  /**
   * 回す中心を、いまのモードに合わせて置き直す。
   * 決まらなければ（選択が空、何も拾えない）**いまの中心のまま**にする。
   */
  private applyOrbitCenter(p: { hit: { point: Vec3 } | null }): void {
    const scene = this.editor.store.scene;
    const z = activeLevel(scene).wallHeight / 2;
    switch (this.orbitCenter) {
      case "all": {
        const b = sceneBounds(scene);
        if (b)
          lookAt(
            this.camera,
            vec3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, z),
          );
        return;
      }
      case "selection": {
        const b = refsBounds(scene, this.editor.store.selection);
        if (b)
          lookAt(
            this.camera,
            vec3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, z),
          );
        return;
      }
      case "pick":
        if (p.hit) lookAt(this.camera, p.hit.point);
        return;
      case "origin":
        lookAt(this.camera, vec3(0, 0, 0));
    }
  }

  /** 歩き回る視点にする。いまの注視点の真下、目線の高さに立つ */
  flyOverHere(eyeHeight = 1500): void {
    flyOver(this.camera, this.camera.target, eyeHeight);
    this.requestRender();
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

  /**
   * いまのメッシュ。**変わった実体だけ作り直す。**
   *
   * シーンの版では見ない。版はシーン全体の単位なので、壁を 1 本動かすと
   * 全部作り直すことになる。ドラッグ中は毎フレーム版が上がるので、
   * ここが効いてくる。
   */
  private get mesh(): Face3[] {
    return this.meshCache.faces(this.editor.store.scene, this.editor.rooms);
  }

  /** 直近の組み立てで何を作り直したか。開発時の計測が読む */
  get meshStats(): {
    walls: number;
    fixtures: number;
    instances: number;
    floors: number;
  } {
    return this.meshCache.stats;
  }

  /** いまの面。**開発時の確認と e2e のため**で、描画には使わない */
  meshNow(): Face3[] {
    return this.mesh;
  }

  /**
   * 1 フレームの内訳を測る。**開発時だけ**（`window.minicad.viewer.profile()`）。
   *
   * 「速くなったはず」を数字にしておかないと、あとから入った無駄に気づけない。
   * 家具を 1mm ずつ動かしながら回すので、ドラッグ中と同じ負荷になる。
   */
  profile(frames = 120): {
    rooms: number;
    mesh: number;
    paint: number;
    stats: string;
  } {
    const scene = this.editor.store.scene;
    const ids = Object.keys(scene.instances);
    const nudge = () => {
      const inst = ids.length ? scene.instances[ids[0]] : null;
      if (inst) inst.x += 1;
    };

    const time = (fn: () => void): number => {
      const t0 = performance.now();
      for (let i = 0; i < frames; i += 1) {
        nudge();
        fn();
      }
      return (performance.now() - t0) / frames;
    };

    const rooms = time(() => void this.editor.rooms);
    const mesh = time(() => void this.mesh);
    const paintMs = time(() => this.draw());
    return {
      rooms: Number(rooms.toFixed(3)),
      mesh: Number(mesh.toFixed(3)),
      paint: Number(paintMs.toFixed(3)),
      stats: JSON.stringify(this.meshCache.stats),
    };
  }

  /** いま効いている 3D の道具 */
  get tool3d(): Tool3D {
    return this.tool;
  }

  /** 3D の道具を選ぶ。`null` で選択に戻る */
  setTool3D(tool: Tool3D | null): void {
    if (this.tool !== this.select) this.tool.cancel(this.editor);
    this.tool = tool ?? this.select;
    this.canvas.style.cursor = this.tool === this.select ? "" : "crosshair";
    this.requestRender();
  }

  /**
   * 面を割った木。**顔ぶれが変わったときだけ建て直す。**
   *
   * 判定は指紋ではなく**面の同一性**で見る。`MeshCache` は変わっていない実体の
   * 面の配列をそのまま使い回すので、1 枚でも差し替わればここで分かる。
   * 指紋をもう 1 つ持つと、`MeshCache` と二重管理になって片方だけ腐る。
   */
  private bsp: { faces: Face3[]; tree: BspNode | null } | null = null;

  /** 奥から手前に並べた面。木が無ければ `paint` の重心ソートに任せる */
  private ordered(mesh: Face3[]): Face3[] {
    if (!this.bsp || !sameFaces(this.bsp.faces, mesh)) {
      this.bsp = { faces: mesh, tree: buildBsp(mesh) };
    }
    return bspOrder(this.bsp.tree, cameraBasis(this.camera).eye);
  }

  private draw(): void {
    paint(
      this.ctx,
      this.camera,
      this.ordered(this.mesh),
      this.width,
      this.height,
      {
        showEdges: this.showEdges,
        dpr: this.dpr,
        presorted: true,
        tint: highlightOf(this.editor, this.materials),
      },
    );
    // **作図の補助は 2 回目の塗りで重ねる**（`PaintOptions.clear` の経緯）。
    // 図面の面と同じ列に混ぜると、壁に敷いた格子が壁に隠れる
    // **測った結果も補助。** 道具を離れても見えるように、道具の重ねものと
    // 一緒に出す（図面のメッシュには混ぜない——計測は図面の一部ではない）
    const overlay = [
      ...measurementFaces(this.editor.store.scene),
      ...this.tool.overlay(this.editor),
    ];
    if (overlay.length > 0) {
      paint(this.ctx, this.camera, overlay, this.width, this.height, {
        dpr: this.dpr,
        clear: false,
      });
    }
    this.drawMeasurementLabels();
    this.drawComments();
  }

  /**
   * 測った距離の数字。**面ではないので `paint` の後に重ねる**（バッジと同じ）。
   *
   * 2D は線の脇に出している。3D でも同じものが読めないと、測った意味が薄い。
   */
  private drawMeasurementLabels(): void {
    const scene = this.editor.store.scene;
    const list = Object.values(scene.measurements);
    if (list.length === 0) return;
    const view = viewProjection(this.camera, this.width, this.height);
    const c2 = this.ctx;
    c2.save();
    c2.scale(this.dpr, this.dpr);
    c2.font = "11px system-ui, sans-serif";
    c2.textAlign = "center";
    c2.textBaseline = "middle";
    for (const m of list) {
      if (!getLayer(scene.layers, m.layerId, LAYER_IDS.draft).visible) continue;
      const floor = levelOf(scene, m.levelId).floorZ;
      const at = projectPoint(
        view,
        vec3(
          (m.a.x + m.b.x) / 2,
          (m.a.y + m.b.y) / 2,
          floor + (m.a.z + m.b.z) / 2,
        ),
        this.width,
        this.height,
      );
      if (!at) continue;
      const text = `${Math.round(distanceOf(m))} mm`;
      const w = c2.measureText(text).width;
      c2.fillStyle = "rgba(255,255,255,0.92)";
      c2.fillRect(at.x - w / 2 - 5, at.y - 9, w + 10, 18);
      c2.strokeStyle = theme.snap;
      c2.lineWidth = 1;
      c2.strokeRect(at.x - w / 2 - 5, at.y - 9, w + 10, 18);
      c2.fillStyle = theme.dimensionText;
      c2.fillText(text, at.x, at.y + 0.5);
    }
    c2.restore();
  }

  /**
   * コメントのバッジ。**面ではないので `paint` の後に重ねる。**
   *
   * z は階の床からの高さ。平面で置いたものは床の上に出るので、
   * 2D と 3D で同じ点を指していることが見て分かる。
   */
  private drawComments(): void {
    const comments = this.editor.comments;
    if (comments.length === 0) return;
    const view = viewProjection(this.camera, this.width, this.height);
    const c2 = this.ctx;

    // `paint` は裏バッファの画素で描くので DPR 込み。バッジは CSS px で
    // 描きたい（ズームに依らず同じ大きさ）ので、ここで尺度を入れ直す
    c2.save();
    c2.scale(this.dpr, this.dpr);
    c2.font = "11px system-ui, sans-serif";
    c2.textAlign = "center";
    c2.textBaseline = "middle";
    comments.forEach((c, i) => {
      const p = this.commentScreen(c, view);
      if (!p) return;
      c2.beginPath();
      c2.arc(p.x, p.y, COMMENT_BADGE_R, 0, Math.PI * 2);
      c2.fillStyle = theme.commentBadge;
      c2.fill();
      c2.strokeStyle = "#fff";
      c2.lineWidth = 1.5;
      c2.stroke();
      c2.fillStyle = "#fff";
      c2.fillText(String(i + 1), p.x, p.y + 0.5);
    });
    c2.restore();
  }

  private commentScreen(c: CommentAnchor, view: View): Vec | null {
    const level = levelOf(this.editor.store.scene, c.levelId);
    return projectPoint(
      view,
      vec3(c.at.x, c.at.y, level.floorZ + c.at.z),
      this.width,
      this.height,
    );
  }

  /** 画面の点に当たるバッジ。3D でもクリックで開ける */
  commentAt(x: number, y: number): CommentAnchor | null {
    const view = viewProjection(this.camera, this.width, this.height);
    // 後から置いたものが上に来るので逆順に見る
    for (let i = this.editor.comments.length - 1; i >= 0; i--) {
      const c = this.editor.comments[i];
      const p = this.commentScreen(c, view);
      if (p && Math.hypot(p.x - x, p.y - y) <= COMMENT_BADGE_R) return c;
    }
    return null;
  }

  /** いまの状態の説明。ステータスバーが 3D のときに読む */
  status(): string {
    return this.tool.status(this.editor);
  }

  /**
   * 片付ける。**window に付けた Esc の捕捉と `ResizeObserver` が残るため。**
   * どちらもキャンバスを DOM から外しただけでは止まらない。
   */
  destroy(): void {
    this.teardown.abort();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  /** 3D で何かを掴んでいる最中か。分割中にどちらの説明を出すかの判断に使う */
  isGrabbing(): boolean {
    return this.select.isActive();
  }

  /**
   * 画面の点に何が当たるか。**開発時の確認と e2e のため**で、描画には使わない。
   * `window.minicad.viewer.hitAt(x, y)`
   */
  hitAt(
    x: number,
    y: number,
  ): { kind: string; id: string; height: number | null } | null {
    const ray = screenRay(this.camera, x, y, this.width, this.height);
    const hit = pickEntity(this.editor, ray, this.mesh, NEAR_PICK);
    if (!hit?.ref) return null;
    const wall =
      hit.ref.type === "wall"
        ? this.editor.store.scene.walls[hit.ref.id]
        : null;
    return {
      kind: wall && isWallTop(hit) ? "wallTop" : hit.ref.type,
      id: hit.ref.id,
      height: wall
        ? wallHeightOf(wall, levelOf(this.editor.store.scene, wall.levelId))
        : null,
    };
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
    const ray = screenRay(
      this.camera,
      screen.x,
      screen.y,
      this.width,
      this.height,
    );
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

  /** canvas の寸法と DPR を取り直す。**距離の計測とは無関係** */
  private measureCanvas(): void {
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
      this.measureCanvas();
      this.requestRender();
    };
    this.resizeObserver = new ResizeObserver(apply);
    this.resizeObserver.observe(this.canvas);
  }

  private attachEvents(): void {
    const canvas = this.canvas;
    canvas.style.touchAction = "none";

    // **カメラか選択かは、動かしたかどうかで決める。**
    // 素の左ドラッグは今まで通り回転。動かさずに離したときだけ選択に回る。
    // 「ドラッグで回す」は 3D の基本操作なので、修飾キー送りにはしない。
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      this.last = { x: e.clientX, y: e.clientY };
      this.downAt = { x: e.clientX, y: e.clientY };
      this.moved = false;

      // 中ボタンと Shift+左はいつでもカメラ
      if (e.button === 1 || e.shiftKey) {
        this.dragging = "pan";
        return;
      }

      // **バッジがいちばん手前。** 図面の上に重ねた印なので、下の面より先に拾う
      const badge = this.commentAt(
        e.clientX - canvas.getBoundingClientRect().left,
        e.clientY - canvas.getBoundingClientRect().top,
      );
      if (badge) {
        this.dragging = null;
        this.onCommentOpen?.(badge.id);
        return;
      }

      const p = this.pointer(e);

      // **置く道具のときは、押した時点では何もしない。**
      // 動かさずに離したら置く、動かしたら回す。ドラッグで回せなくなると
      // 「置きたい場所を正面に持ってくる」ができなくなる
      if (this.tool !== this.select) {
        this.applyOrbitCenter(p);
        this.dragging = "orbit";
        return;
      }

      // **掴んだものがあれば動かす、無ければ回す。**
      // 「何も無いところをドラッグ＝回転」は 3D の基本操作なので残す
      if (p.hit?.ref) {
        this.dragging = null;
        this.select.onPointerDown(this.editor, p);
        return;
      }
      // **回す前に中心を決める。** 距離と角度はそのままなので、
      // 見ている向きは変わらず、回る軸だけが移る
      this.applyOrbitCenter(p);
      this.dragging = "orbit";
      this.select.onPointerDown(this.editor, p);
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!this.dragging) {
        // 選択中のものを掴んでいるか、ただのホバーか。Select3D が決める
        this.tool.onPointerMove(this.editor, this.pointer(e));
        this.requestRender();
        return;
      }
      if (
        !this.moved &&
        Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) >
          CLICK_SLOP
      ) {
        this.moved = true;
      }
      const dx = e.clientX - this.last.x;
      const dy = e.clientY - this.last.y;
      this.last = { x: e.clientX, y: e.clientY };
      if (this.dragging === "pan") pan(this.camera, dx, dy, this.height);
      else orbit(this.camera, dx, dy);
      this.requestRender();
    });

    canvas.addEventListener("pointerleave", () => {
      this.tool.onPointerLeave(this.editor);
      this.requestRender();
    });

    canvas.addEventListener("pointerup", (e) => {
      if (canvas.hasPointerCapture(e.pointerId))
        canvas.releasePointerCapture(e.pointerId);
      const clicked = !this.moved;
      this.dragging = null;
      this.moved = false;
      // 置く道具は「動かさずに離した」ときだけ効く（回しただけでは置かない）
      if (this.tool !== this.select && clicked)
        this.tool.onPointerDown(this.editor, this.pointer(e));
      this.tool.onPointerUp(this.editor);
      this.requestRender();
    });

    canvas.addEventListener("pointercancel", (e) => {
      if (canvas.hasPointerCapture(e.pointerId))
        canvas.releasePointerCapture(e.pointerId);
      this.dragging = null;
      this.moved = false;
      this.tool.cancel(this.editor);
    });

    // **Esc は捕捉段で取る。** `installKeymap` は window の keydown を見ていて、
    // 3D のドラッグ中でも選択解除が先に走ってしまう。ここで止める
    window.addEventListener(
      "keydown",
      (e) => {
        if (!this.visible || !this.tool.isActive()) return;
        if (e.key !== "Escape") return;
        if (this.tool.cancel(this.editor)) {
          e.stopPropagation();
          e.preventDefault();
          this.requestRender();
        }
      },
      { capture: true, signal: this.teardown.signal },
    );
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    canvas.addEventListener(
      "wheel",
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

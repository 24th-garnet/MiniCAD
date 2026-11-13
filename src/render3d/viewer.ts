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
  cameraEye,
  faceYaw,
  lookAround,
  orbit,
  pivotAround,
  walkTo,
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
  pickFloor,
  Select3D,
  type Pointer3D,
  type Tool3D,
} from "./interact.ts";
import { Place3D } from "./place3d.ts";
import { Measure3D, measurementFaces } from "./measure3d.ts";
import { Comment3D } from "./comment3d.ts";
import { Draw3D } from "./draw3d.ts";
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
import { pickRay, screenRay } from "./ray.ts";

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

/** 歩くときの目線の高さ (mm)。日本人の平均身長からの目線 */
const EYE_HEIGHT = 1500;

/**
 * 歩いているときの「見ている先までの距離」(mm)。
 *
 * 一人称では画面に出ないが、軌道カメラの型をそのまま使うので 0 にはできない
 * （向きが決まらない）。1.5m 前方を見ている形にしておく。
 */
const MIN_LOOK = 1500;

/**
 * 立った直後の俯角（ラジアン）。足元の床が画角に入る程度に下を向く。
 *
 * **この型では正が見下ろし。** 目は `target.z + distance·sin(pitch)` なので、
 * 正で目が注視点より上＝見下ろしになる。符号を取り違えると空を向く。
 *
 * **値はサンプル間取りの LDK で測って決めた。** 画面を 19×19 で割り、
 * 床として叩ける点がいくつあるか：俯角 0.2 → 0、0.3 → 4、0.4 → 18、0.5 → 34。
 * 水平に近いと壁と家具で埋まり、**最初の 1 歩が踏めない**。下を向きすぎると
 * 足元しか見えない。その間を採る
 */
const START_PITCH = 0.45;

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
  private dragging: "orbit" | "pan" | "look" | null = null;
  private last = { x: 0, y: 0 };
  private readonly select = new Select3D();
  /** ソリッドを 3D の中に置く道具。選択と入れ替えて使う */
  readonly place = new Place3D();
  /** 3D の中で 2 点間を測る道具。測った結果は 2D の計測と同じ実体になる */
  readonly measure = new Measure3D();
  /** 3D の中でコメントを置く道具。シーンには入らない（ホストの持ち物） */
  readonly comment = new Comment3D();
  /** 作図面の上に多角形を描いて、その場で押し出した立体にする道具 */
  readonly draw = new Draw3D();
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
    this.paintFrame();
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

  /**
   * 歩いているあいだ、描き直すたびに鳴る。`App` が差し込む。
   *
   * **「動いたとき」ではなく毎フレーム。** 見回している最中も平面の矢は
   * 回り続ける必要があるので、位置と向きの両方をここで流す。
   * **歩いていないときは鳴らさない**——普段のカメラ操作で鳴らすと、
   * 3D を触るだけで 2D を毎フレーム描き直すことになる。
   */
  onWalkMove: (() => void) | null = null;

  /** ホストのカタログから表示色を取り込む。渡されなければ既定の 5 色のまま */
  setMaterialColors(colors: ReadonlyMap<string, string>): void {
    this.materials = colors;
    this.requestRender();
  }

  /**
   * 回す中心を置き直す。
   *
   * **押すたびには効かせない。** 以前はドラッグのたびに呼んでいたので、
   * 「全図形の中心」のまま 3D を触ると、押した瞬間に注視点が建物の中心へ
   * 戻り、**歩いている位置が 1 回のドラッグで消えていた**。中心の選び直しは
   * 人が選んだときの 1 回だけにする。
   *
   * **「指したところ」だけは押すたび。** それがこの選択の意味そのもの
   * （いま叩いた点を軸に回す）。ただし `pivotAround` で移すので、
   * 目の位置は動かず、回る軸だけが移る。
   *
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
        if (p.hit) pivotAround(this.camera, p.hit.point);
        return;
      case "origin":
        lookAt(this.camera, vec3(0, 0, 0));
    }
  }

  /**
   * 回す中心を選び直す。**選んだその場で 1 回だけ効く。**
   *
   * 「指したところ」は押した点が要るので、ここでは何もしない——
   * 次にドラッグを始めたときに効く。
   */
  setOrbitCenter(center: OrbitCenter): void {
    this.orbitCenter = center;
    this.applyOrbitCenter({ hit: null });
    this.requestRender();
  }

  /**
   * ドラッグを始めるときの中心合わせ。**「指したところ」のときだけ動かす。**
   *
   * 他の選び方（全図形・選択・原点）は、選んだ瞬間に 1 回効けば足りる。
   * 押すたびに効かせると、人が動かしたカメラを毎回取り消すことになる。
   */
  private aimPivot(p: { hit: { point: Vec3 } | null }): void {
    if (this.orbitCenter === "pick") this.applyOrbitCenter(p);
  }

  /**
   * ウォークスルー（一人称で歩き回る）に入っているか。
   *
   * **道具ではない。** 道具は「何を作るか」で、これは「どう見るか」。
   * ワイヤー（`20_案件詳細_現状図面` 4 枚目）も画面ごと切り替わると書いている。
   *
   * **ビューにも足さない。** `ViewMode` の 4 つめにすると、歩きながら分割に
   * できなくなる——2D に現在位置を出すのは分割のときなので、それでは困る。
   * 歩行はビューと直交する。
   */
  walking = false;
  /** 床でないところを叩いたときの理由。次に動いたら消す */
  private refusal: string | null = null;

  /**
   * 歩き始める／やめる。
   *
   * 始めるときは**原点に立つ**（ワイヤー「xyz=0 の地点からウォークスルーが
   * 開始」）。ただし原点に床が無ければ、いちばん広い部屋の中心へ寄せる——
   * 図面を原点から描いていない物件では、壁の外や宙に浮いた位置から
   * 始まってしまうため。
   *
   * **やめてもカメラは戻さない。** 戻した瞬間に視点が飛ぶと、何が起きたのか
   * 分からなくなる。見ていた場所から続けられるほうがよい。
   */
  setWalking(on: boolean): void {
    if (this.walking === on) return;
    this.walking = on;
    if (on) this.standAtStart();
    this.canvas.style.cursor = on ? "crosshair" : "";
    this.requestRender();
  }

  /** 歩き始める場所。原点に床が無ければ、いちばん広い部屋の中心へ */
  private standAtStart(): void {
    const scene = this.editor.store.scene;
    // **距離は詰める。** 入る前の引いた構図（数十 m）をそのまま持ち込むと、
    // 平行移動の 1 ドラッグが何 m も滑る
    this.camera.distance = MIN_LOOK;
    // **やや下を向く。** 水平のまま立つと足元の床が画角に入らず、
    // 「床をクリックで移動」が最初の 1 歩から使えない（Matterport も下向きで始まる）
    this.camera.pitch = START_PITCH;
    // **目線の高さを合わせるのは「目」であって注視点ではない。**
    // 目は注視点から `distance·sin(pitch)` だけ上なので、その分を引いて置く
    const eyeZ = activeLevel(scene).floorZ + EYE_HEIGHT;
    const z = eyeZ - this.camera.distance * Math.sin(this.camera.pitch);
    this.camera.target = vec3(this.camera.target.x, this.camera.target.y, z);

    /**
     * 立つ場所。**ワイヤーどおり原点から。**
     *
     * 原点に床が無ければ（図面を原点から描いていない物件では壁の外や宙に
     * なる）、広い部屋から順に中心を試す。**ただの重心では家具の中に立つ**
     * ——サンプル間取りの LDK の重心はダイニングテーブルの真ん中で、
     * そこから見ると画面が机の内側で埋まり、床が 1 点も叩けない
     */
    const rooms = [...this.editor.rooms]
      .filter((r) => !r.outdoor && r.levelId === scene.activeLevelId)
      .sort((a, b) => b.floorArea - a.floorArea);
    const spots: Vec[] = [{ x: 0, y: 0 }, ...rooms.map((r) => r.center)];
    const clear = spots.find((q) => this.standsOnClearFloor(q.x, q.y, eyeZ));
    const at = clear ?? rooms[0]?.center ?? { x: 0, y: 0 };
    walkTo(this.camera, at.x, at.y);
    this.faceOpenSpace();
  }

  /**
   * 空いているほうを向く。
   *
   * **向きを引き継ぐと、だいたい家具の天板で画面が埋まる。** 入る前の軌道
   * カメラは建物を外から見ているので、その方角をそのまま一人称に持ち込むと
   * 目の前 1m に机があたりまえに来る（サンプル間取りで実際にそうなった）。
   * 目線から 16 方角へ投げて、**いちばん遠くまで届く向き**を選ぶ。
   *
   * 何にも当たらない方角（開口から外へ抜ける）は最遠として扱う——
   * そこが画面でいちばん開けている、で正しい。
   */
  private faceOpenSpace(): void {
    const eye = cameraEye(this.camera);
    const sp = Math.sin(this.camera.pitch);
    const cp = Math.cos(this.camera.pitch);
    let bestYaw = this.camera.yaw;
    let bestT = -1;
    for (let i = 0; i < 16; i++) {
      const yaw = (i * Math.PI * 2) / 16;
      // 目から注視点へ向かう向き。`cameraEye` の式の符号を反転したもの
      const direction = vec3(-cp * Math.cos(yaw), -cp * Math.sin(yaw), -sp);
      const hit = pickRay({ origin: eye, direction }, this.mesh, NEAR_PICK);
      const t = hit ? hit.t : Number.POSITIVE_INFINITY;
      if (t > bestT) {
        bestT = t;
        bestYaw = yaw;
      }
    }
    faceYaw(this.camera, bestYaw);
  }

  /**
   * そこに立てるか。**目の高さから真下へ落として、最初に当たるのが床か**を見る。
   *
   * 床があるかだけでは足りない——家具の中に立つと、足元の床より先に机の
   * 天板や箱の内側が来る。「最初に当たるのが床」なら、空いた床の上に立てる。
   */
  private standsOnClearFloor(x: number, y: number, eyeZ: number): boolean {
    const down = { origin: vec3(x, y, eyeZ), direction: vec3(0, 0, -1) };
    return pickFloor(this.editor, down, this.mesh, 1) !== null;
  }

  /**
   * 叩いたところへ移る。**床でなければ動かず、理由を状況表示に出す。**
   *
   * 壁の手前が返れば床ではないので断られる——歩いて壁をすり抜けないのは、
   * 当たり判定ではなく「床しか行き先にしない」ことで保たれている。
   */
  private stepTo(p: Pointer3D): void {
    const floor = pickFloor(this.editor, p.ray, this.mesh, NEAR_PICK);
    if (!floor) {
      this.refusal = "床をクリックしてください（壁や家具の上へは移れません）";
      return;
    }
    this.refusal = null;
    walkTo(this.camera, floor.point.x, floor.point.y);
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
      this.paintFrame();
      if (this.walking) this.onWalkMove?.();
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
    const paintMs = time(() => this.paintFrame());
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

  /** 1 フレーム塗る。**多角形を描く道具（）とは無関係** */
  private paintFrame(): void {
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
    if (this.walking) {
      return this.refusal
        ?? "床をクリックで移動 / ドラッグで見回す / 「解除」で戻る";
    }
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
   * 画面の点の先にある床。**歩く先の確認用**（`hitAt` は床を外すので測れない）。
   * `window.minicad.viewer.floorAt(x, y)`
   */
  floorAt(x: number, y: number): { x: number; y: number } | null {
    const ray = screenRay(this.camera, x, y, this.width, this.height);
    const hit = pickFloor(this.editor, ray, this.mesh, NEAR_PICK);
    return hit ? { x: hit.point.x, y: hit.point.y } : null;
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

      // **歩いているあいだは見回す。** バッジだけは先に拾う（下で）
      if (this.walking) {
        const badge = this.commentAt(
          e.clientX - canvas.getBoundingClientRect().left,
          e.clientY - canvas.getBoundingClientRect().top,
        );
        if (badge) {
          this.dragging = null;
          this.onCommentOpen?.(badge.id);
          return;
        }
        this.refusal = null;
        this.dragging = "look";
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
        this.aimPivot(p);
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
      // **回す前に中心を決める。** 移すのは「指したところ」のときだけで、
      // そのときも目の位置は動かない（`pivotAround`）
      this.aimPivot(p);
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
      // **見回しは目を動かさない。** 回すと目そのものが横へ滑る
      else if (this.dragging === "look") lookAround(this.camera, dx, dy);
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
      const wasLooking = this.dragging === "look";
      this.dragging = null;
      this.moved = false;
      // **歩いているあいだは、動かさずに離したら床へ移る。**
      // ワイヤー「移動位置をクリックすれば、視点の xy 座標が移動する」
      if (this.walking) {
        if (wasLooking && clicked) this.stepTo(this.pointer(e));
        this.requestRender();
        return;
      }
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
        // **歩いているあいだは寄れない。** 一人称に「注視点との距離」は
        // 意味が無く、変えると目線の高さだけが静かに狂う
        if (this.walking) return;
        // 2D と同じ係数。トラックパッドの手触りを揃える
        const intensity = e.ctrlKey ? 0.01 : 0.0015;
        dolly(this.camera, Math.exp(-e.deltaY * intensity));
        this.requestRender();
      },
      { passive: false },
    );
  }
}

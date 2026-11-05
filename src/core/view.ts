import type { Id } from "./id.ts";
import { defaultLayers, LAYER_IDS, type Layer, type LayerId } from "./layer.ts";
import type { Scene } from "./types.ts";

/**
 * 図面ビュー。**CAD の画層ではなく、紙空間のビューポート。**
 *
 * ワイヤーの「レイヤー」（躯体図 / 平面配置 / 天井伏図 / 照明詳細図 /
 * 避難経路図、各々 1/100、透過つき）は、よく見ると**画層の選択と、縮尺と、
 * 画層ごとの不透明度**の組で、画層そのものではない。
 *
 * **`Layer` に縮尺を持たせない。** `Layer` は DXF の LAYER テーブルに 1:1 で
 * 対応していて、LAYER に縮尺は無い。持たせると DXF 相互運用を成立させている
 * 性質が壊れる。
 *
 * ## どう効くか
 *
 * **ビューを切り替えるときに、出ていくビューへ今の状態を控え、
 * 入るビューの状態を当てる。** 当てた後は `Layer.visible` と
 * `standard.scale` が今までどおり唯一の出どころなので、描画も SVG も DXF も
 * 1 行も変わらない。「読むたびにビュー越しに解決する」方式にすると、
 * 画層を読む 15 箇所すべてを通さないといけなくなる。
 *
 * ## 画面では「レイヤー」と呼ぶ
 *
 * 利用者の言葉と合わせる。データモデルを view と呼ぶのとの不一致は、
 * 恒久的な小さな税。**永久に間違ったモデルより安い。**
 */
export interface DrawingView {
  id: Id;
  name: string;
  /** 図面の尺度。1:100 なら 100 */
  scale: number;
  /** 画層ごとの見え方。欄の無い画層は触らない */
  layerStates: Record<LayerId, LayerViewState>;
}

export interface LayerViewState {
  visible: boolean;
  /** 0〜1。1 が不透明。**DXF R12 には出せない**（書き出しで報告する） */
  opacity: number;
}

export const DEFAULT_VIEW_ID = "view-1";

/**
 * **新しい図面の初期値。** ワイヤー 5 枚目のレイヤー節が「初期表示」として
 * 6 つ挙げているものに当たる。
 *
 * **6 つのうち 2 つは図面ではなく画層だった。** 本文の一覧は
 * 現状図 / レイアウト図 / 天井伏図 / 立面図 / **注釈（テキスト）** / **寸法**で、
 * 後ろの 2 つは紙に載る内容そのもの——`A-ANNO-TEXT` と `A-DIMS` として
 * **画層側に前からある**。縮尺や透過を持つ単位ではないので、ここには入れない。
 *
 * **どの図面を納めるかは CAD の流儀では決まらない。** ワイヤーの本文と
 * モックで一覧が食い違っている（モックは躯体図 / 平面配置 / レイアウト図 /
 * 天井伏図 / 照明詳細図 / 避難経路図）。両方に出てくるのは
 * **レイアウト図と天井伏図**の 2 つだけで、残りは何を納品するかの話。
 * 本文の 4 つを初期値に採ったが、**画面から名前の変更・追加・削除ができる**ので、
 * 外れていても消して足すだけで直る。
 *
 * 見え方の違いは、流儀で決まるものだけ付けてある。
 *
 * | 図面 | 隠すもの | なぜ |
 * | --- | --- | --- |
 * | 現状図 | （なし） | 基準 |
 * | レイアウト図 | 通り芯 | 施主に見せる図に構造の基準線は出さない |
 * | 天井伏図 | 家具 | **床置きの家具は天井を見上げた図に出ない** |
 * | 立面図 | （なし） | 立面を書き出すときに切り替える縮尺の控え |
 *
 * **どの図面も全部の画層について意図を持つ。** 隠すものだけ書くと、
 * 切り替えた順で結果が変わってしまう（`activateView` は欄の無い画層を
 * 触らないため）。
 */
export function initialViews(scale: number): Record<Id, DrawingView> {
  // **全部の画層を書く。** 欄の無い画層は切り替えのときに触らないので、
  // 隠すものだけ書くと**前に見ていた図面の状態が残る**（天井伏図で家具を
  // 消したあとレイアウト図へ移ると、家具が消えたまま）。画面で見つけた
  const all = Object.keys(defaultLayers()) as LayerId[];
  const make = (id: Id, name: string, hide: LayerId[]): DrawingView => ({
    id,
    name,
    scale,
    layerStates: Object.fromEntries(
      all.map((layerId) => [
        layerId,
        { visible: !hide.includes(layerId), opacity: 1 },
      ]),
    ),
  });
  return {
    [DEFAULT_VIEW_ID]: make(DEFAULT_VIEW_ID, "現状図", []),
    "view-layout": make("view-layout", "レイアウト図", [LAYER_IDS.axis]),
    "view-ceiling": make("view-ceiling", "天井伏図", [LAYER_IDS.furniture]),
    "view-elevation": make("view-elevation", "立面図", []),
  };
}

/**
 * 図面を 1 枚だけ。**図面を持たない古いファイルの受け皿。**
 *
 * 初期値（{@link initialViews}）とは別にしてある——**既に中身のあるファイルに
 * 4 枚の控えを生やすのは余計**で、そのファイルは 1 枚ぶんの状態しか持っていない。
 */
export function defaultViews(scale: number): Record<Id, DrawingView> {
  return {
    [DEFAULT_VIEW_ID]: {
      id: DEFAULT_VIEW_ID,
      name: "平面図",
      scale,
      layerStates: {},
    },
  };
}

/** 作業中のビュー。壊れたファイルでも何か返す */
export function activeView(scene: Scene): DrawingView {
  return (
    scene.views[scene.activeViewId] ??
    Object.values(scene.views)[0] ?? {
      id: DEFAULT_VIEW_ID,
      name: "平面図",
      scale: scene.standard.scale,
      layerStates: {},
    }
  );
}

/** 並び順。作った順を保つ */
export const viewsInOrder = (scene: Scene): DrawingView[] =>
  Object.values(scene.views);

/** いまの画層と尺度を、作業中のビューに控える */
export function captureView(scene: Scene): void {
  const view = scene.views[scene.activeViewId];
  if (!view) return;
  view.scale = scene.standard.scale;
  view.layerStates = {};
  for (const layer of Object.values(scene.layers)) {
    view.layerStates[layer.id] = {
      visible: layer.visible,
      opacity: layer.opacity,
    };
  }
}

/**
 * ビューを切り替える。**出ていくビューを控えてから、入るビューを当てる。**
 *
 * 同じビューなら何もしない。控えてから当て直すと、`layerStates` を
 * 持たない画層の状態が消える。
 */
export function activateView(scene: Scene, id: Id): boolean {
  if (!scene.views[id] || scene.activeViewId === id) return false;
  captureView(scene);
  scene.activeViewId = id;
  applyView(scene, scene.views[id]);
  return true;
}

/** ビューの状態を今の画層と尺度に当てる */
export function applyView(scene: Scene, view: DrawingView): void {
  scene.standard.scale = view.scale;
  for (const [layerId, state] of Object.entries(view.layerStates)) {
    const layer: Layer | undefined = scene.layers[layerId];
    if (!layer) continue;
    layer.visible = state.visible;
    layer.opacity = state.opacity;
  }
}

/** 不透明度を 0〜1 に収める。読み込みと入力の両方で通す */
export const clampOpacity = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;

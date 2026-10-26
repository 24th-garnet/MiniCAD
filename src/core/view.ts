import type { Id } from './id.ts';
import type { Layer, LayerId } from './layer.ts';
import type { Scene } from './types.ts';

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

export const DEFAULT_VIEW_ID = 'view-1';

export function defaultViews(scale: number): Record<Id, DrawingView> {
  return {
    [DEFAULT_VIEW_ID]: { id: DEFAULT_VIEW_ID, name: '平面図', scale, layerStates: {} },
  };
}

/** 作業中のビュー。壊れたファイルでも何か返す */
export function activeView(scene: Scene): DrawingView {
  return scene.views[scene.activeViewId] ?? Object.values(scene.views)[0]
    ?? { id: DEFAULT_VIEW_ID, name: '平面図', scale: scene.standard.scale, layerStates: {} };
}

/** 並び順。作った順を保つ */
export const viewsInOrder = (scene: Scene): DrawingView[] => Object.values(scene.views);

/** いまの画層と尺度を、作業中のビューに控える */
export function captureView(scene: Scene): void {
  const view = scene.views[scene.activeViewId];
  if (!view) return;
  view.scale = scene.standard.scale;
  view.layerStates = {};
  for (const layer of Object.values(scene.layers)) {
    view.layerStates[layer.id] = { visible: layer.visible, opacity: layer.opacity };
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
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;

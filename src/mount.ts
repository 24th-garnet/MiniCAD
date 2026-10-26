import { sceneToMeasures, type MeasuresFile } from './io/measures.ts';
import { deserialize, serialize, type SceneFile } from './io/scene.ts';
import type { Scene } from './core/types.ts';
import type { MiniCad, MountOptions } from './host.ts';
import type { Mode } from './ui/mode.ts';
import { App } from './ui/app.ts';
import './style.css';

/**
 * ホストのページに MiniCAD を組み込む。
 *
 * ```ts
 * const cad = mount(document.getElementById('editor')!, {
 *   scene: await loadFromServer(),
 *   onChange: (file) => void saveToServer(file),
 * });
 * ```
 *
 * **渡された要素の中に骨組みを組む。** 高さはホストが決める（MiniCAD は
 * 貰った箱いっぱいに広がる）。
 *
 * **`scene` は `SceneFile` でも `Scene` でも受ける。** ホストが持っているのは
 * 保存した JSON なので普通は前者で、その場合は `deserialize` を通る
 * ——つまり**参照の整合性検査を必ず通る**。手で組んだ JSON はここで弾かれる。
 */
export function mount(container: HTMLElement, options: MountOptions = {}): MiniCad {
  const app = new App(container, options);
  if (options.scene) app.loadScene(toScene(options.scene));

  const api: MiniCad = {
    getScene: () => serialize(app.editorInstance.store.scene),
    setScene: (file) => app.loadScene(toScene(file)),
    getMeasures: (planId = 'plan-1'): MeasuresFile => {
      const editor = app.editorInstance;
      return sceneToMeasures(editor.store.scene, editor.rooms, { planId });
    },
    get mode(): Mode {
      return app.mode;
    },
    setMode: (mode) => app.setMode(mode),
    setComments: (list) => app.setComments(list),
    capture: (view) => app.capture(view),
    getCamera: () => app.viewer.cameraParams,
    setCamera: (params) => app.viewer.setCameraParams(params),
    destroy: () => app.destroy(),
  };

  // 開発時だけ、コンソールや自動テストから中を触れるようにしておく。
  // `minicad` が中身、`minicadApi` がホストに見えている窓口
  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>;
    w.minicad = app;
    w.minicadApi = api;
    // 組み直しを試せるように、入口そのものも出しておく
    w.mountMiniCad = mount;
  }

  return api;
}

/** 保存した JSON なら読み直す。すでに `Scene` ならそのまま */
function toScene(source: SceneFile | Scene): Scene {
  return 'format' in source ? deserialize(source) : source;
}

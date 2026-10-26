import { loadLocal, saveLocalFile } from './io/scene.ts';
import { sampleScene } from './io/sample.ts';
import { mount } from './mount.ts';

/**
 * 単体で立ち上げたときのホスト。
 *
 * **MiniCAD 自身の契約の最初の利用者がここ。** 図面を渡し、変わったら保存する
 * ——ホストに頼んでいることと同じことを、自分でやっている。契約が飾りに
 * ならないように、既定の立ち上げ方そのものを契約の上に載せてある。
 */
const host = document.getElementById('app');
if (!host) throw new Error('#app が見つかりません');

/** 保存はホストの仕事。まとめ方もホストが決める */
const SAVE_DELAY_MS = 600;
let saveTimer: number | undefined;

mount(host, {
  // 前回の続きがあれば復元し、初回はサンプル間取りで始める
  scene: loadLocal() ?? sampleScene(),
  onChange: (file) => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => saveLocalFile(file), SAVE_DELAY_MS);
  },
});

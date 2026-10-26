import type { EntityRef, Scene } from './core/types.ts';
import type { SceneFile } from './io/scene.ts';
import type { MeasuresFile } from './io/measures.ts';
import type { Mode } from './ui/mode.ts';

/**
 * ホストとの境界。[docs/host.md](../docs/host.md) が決めた契約の型。
 *
 * **MiniCAD は組み込みエディタに徹する。** 認証・案件・保存・版管理・
 * コメントの通信・ライブラリのマスタはホストが持つ。ここにあるのは、
 * その分担を型にしたものだけ。
 *
 * **そして MiniCAD は単体でも動く。** `src/main.ts` が最初の利用者で、
 * ホストの役を自分で演じている（前回の続きを渡し、変更を localStorage に保存する）。
 * 契約が飾りにならないように、既定の立ち上げ方そのものを契約の上に載せてある。
 */

/** ホストが MiniCAD に渡すもの */
export interface MountOptions extends HostCallbacks {
  /** 最初に開く図面。省略すると空から始まる */
  scene?: SceneFile | Scene;
}

export interface HostCallbacks {
  /** 通常モードかプロモードか。省略すると通常モード */
  mode?: Mode;

  /**
   * 図面が変わった。**保存するかどうかはホストが決める。**
   *
   * 呼ばれるのは図面が本当に変わったときだけで、選択やホバーでは呼ばれない。
   * 連続したドラッグの途中でも呼ばれるので、まとめたいならホスト側で遅らせる。
   */
  onChange?(scene: SceneFile): void;

  /** 選択が変わった。インスペクタをホスト側に出したいときに使う */
  onSelectionChange?(refs: EntityRef[]): void;
}

/** `mount()` が返すもの。ホストから MiniCAD を触る窓口 */
export interface MiniCad {
  /** いまの図面。保存はホスト */
  getScene(): SceneFile;
  /** 図面を差し替える。履歴は捨てる */
  setScene(file: SceneFile | Scene): void;
  /** 解決済みの幾何。`mdr-measures-1` */
  getMeasures(planId?: string): MeasuresFile;
  readonly mode: Mode;
  setMode(mode: Mode): void;
  /** 片付ける。DOM からも window からも自分の痕跡を消す */
  destroy(): void;
}

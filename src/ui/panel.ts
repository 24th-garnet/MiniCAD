import type { Editor } from './editor.ts';
import type { ToolId } from '../tools/tool.ts';
import type { Capabilities, HostCatalogs } from '../host.ts';
import type { Mode } from './mode.ts';
import type { ViewState } from './view-state.ts';
import type { Tool3D } from '../render3d/interact.ts';

/**
 * パネルから編集系の操作を呼ぶための窓口。
 * 各パネルが Editor や Store の作法（commit と update の使い分け）を
 * 個別に知らなくて済むようにしてある。
 */
export interface PanelContext {
  readonly editor: Editor;
  /** 全パネルを描き直す */
  refresh(): void;
  /** 履歴に残る変更（図面の中身） */
  edit(fn: () => void | boolean): void;
  /** 履歴に残らない変更（作図設定・表示） */
  set(fn: () => void): void;
  deleteSelection(): void;
  loadScene(scene: Parameters<Editor['store']['replaceScene']>[0]): void;
  /** どのビューを出しているか。パネルは `Viewer3D` に手を伸ばさずここを読む */
  readonly view: ViewState;
  /** 通常モードかプロモードか */
  mode: Mode;
  /** ホストが許していること。閲覧のみなら `can.edit` が false */
  readonly can: Capabilities;
  /** ホストが渡した部品と素材の一覧 */
  readonly catalogs: HostCatalogs;
  setMode(mode: Mode): void;
  /** ツールを選ぶ。作図のツールなら 2D に戻してから切り替える */
  selectTool(id: ToolId): void;
  /**
   * 3D の道具を選ぶ。`null` で素の選択に戻る。
   *
   * **2D の道具と同時には武装しない。** ここを通すのは、その決まりを
   * `App` 1 か所で守るため——`Viewer3D` を直に触ると、2D 側が武装したまま
   * 残って、ビューを行き来するたびに違うものが効く。
   */
  setTool3D(tool: Tool3D | null): void;
  /**
   * ウォークスルー（一人称で歩き回る）の出入り。
   *
   * **道具ではなくビューでもない。** 道具は「何を作るか」、ビューは「どれを
   * 見るか」で、これは「どう見るか」。入ると道具は全部外れ、3D 単独になる。
   */
  setWalkthrough(on: boolean): void;
  /** いまウォークスルーに入っているか */
  readonly walkthrough: boolean;
  /** いま見えている絵を PNG にする */
  capture(view?: '2d' | '3d'): Promise<Blob | null>;
}

export interface Panel {
  refresh(ctx: PanelContext): void;
}

/** インスペクタの1区画。DOM を返すだけで、どこに差すかは Inspector が決める */
export interface Section {
  render(ctx: PanelContext): (HTMLElement | null)[];
}

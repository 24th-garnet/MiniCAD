import type { Editor } from './editor.ts';
import type { ViewState } from './view-state.ts';

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
}

export interface Panel {
  refresh(ctx: PanelContext): void;
}

/** インスペクタの1区画。DOM を返すだけで、どこに差すかは Inspector が決める */
export interface Section {
  render(ctx: PanelContext): (HTMLElement | null)[];
}

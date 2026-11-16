import { el } from './dom.ts';

/**
 * 最小限のモーダル。
 *
 * `window.confirm` / `window.prompt` は選択肢を 1 つしか置けず、ヘッドレスの
 * ブラウザでは自動的に閉じられてしまうので、DXF 取り込みのように
 * 「設定を見せてから実行する」場面には使えません。
 */

export interface DialogAction {
  label: string;
  primary?: boolean;
  /** false を返すと閉じない */
  onClick?: () => void | false;
}

/**
 * 開いたダイアログを閉じる関数を返す。
 *
 * **`root` は MiniCAD の外枠。** 以前は `document.body` に差していたが、
 * MiniCAD はホストのページに組み込まれるモジュールなので、それは
 * **ホストの DOM に自分のものを置き去りにする**ことだった。実害が 2 つある：
 *
 * 1. スタイルを `.minicad` の下に閉じ込めたとき、body 直下のダイアログだけが
 *    素のブラウザの見た目に戻る
 * 2. `destroy()` は外枠を外すだけなので、**開いたままのダイアログが残る**
 *
 * 根の中に差せば、どちらも起きない。`position: fixed` なので見え方は変わらない。
 */
export function openDialog(
  root: HTMLElement,
  title: string,
  body: (HTMLElement | string)[],
  actions: DialogAction[],
): () => void {
  const backdrop = el('div', { class: 'dialog-backdrop' });

  const close = (): void => {
    backdrop.remove();
    document.removeEventListener('keydown', onKeyDown, true);
  };

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  }

  const buttons = actions.map((action) =>
    el(
      'button',
      {
        type: 'button',
        class: action.primary ? 'primary' : undefined,
        onclick: () => {
          if (action.onClick?.() === false) return;
          close();
        },
      },
      [action.label],
    ),
  );

  const dialog = el('div', { class: 'dialog', role: 'dialog', 'aria-label': title }, [
    el('h2', {}, [title]),
    el('div', { class: 'dialog-body' }, body),
    el('div', { class: 'dialog-actions' }, buttons),
  ]);
  // 背景をクリックしたときだけ閉じる（中身のクリックで閉じない）
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.append(dialog);
  root.append(backdrop);
  document.addEventListener('keydown', onKeyDown, true);
  buttons.find((b) => b.classList.contains('primary'))?.focus();
  return close;
}

/** 等幅・折り返しありの本文。取り込みレポートのような複数行の文字列用 */
export function dialogText(text: string): HTMLElement {
  return el('pre', { class: 'dialog-text' }, [text]);
}

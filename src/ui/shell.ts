import { el } from './dom.ts';

/**
 * 画面の骨組みを組み立てる。
 *
 * **これまで `index.html` に書いてあったものを、そのまま TypeScript に移した。**
 * 移した理由は 1 つだけで、`mount(el, …)` を書くため。ホストの中に埋め込むとき、
 * MiniCAD は**自分が入る箱しか貰えない**ので、中身は自分で組む必要がある。
 *
 * ついでに 1 つ良くなった点がある。これまで `App` は
 * `root.getElementById('status-hint')!` のように id の文字列と `!` で要素を拾っていて、
 * **id を打ち間違えると実行してみるまで分からなかった**。骨組みが要素を返すようになり、
 * 打ち間違いは型エラーになる。
 *
 * **id と class は 1 つも変えていない。** CSS と e2e がそのまま通ることが、
 * 移植が忠実だったことの証拠になる。
 */
export interface Shell {
  readonly root: HTMLElement;
  readonly fileActions: HTMLElement;
  readonly toolbar: HTMLElement;
  readonly canvasWrap: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly canvas3d: HTMLCanvasElement;
  readonly viewTabs: HTMLElement;
  readonly options: HTMLElement;
  readonly numeric: HTMLFormElement;
  readonly numericLabel: HTMLElement;
  readonly numericInput: HTMLInputElement;
  readonly inspector: HTMLElement;
  readonly statusHint: HTMLElement;
  readonly statusReadout: HTMLElement;
}

export function buildShell(host: HTMLElement): Shell {
  const fileActions = el('div', { class: 'file-actions', id: 'file-actions' }, []);
  const toolbar = el('nav', { class: 'toolbar', id: 'toolbar', 'aria-label': 'ツール' }, []);
  const canvas = el('canvas', { id: 'canvas', tabindex: 0 }, []);
  const canvas3d = el('canvas', { id: 'canvas3d', tabindex: 0, hidden: true }, []);
  const viewTabs = el('div', { class: 'view-tabs', id: 'view-tabs' }, []);
  const options = el('div', { class: 'options-bar', id: 'options' }, []);
  const numericLabel = el('label', { for: 'numeric-input', id: 'numeric-label' }, ['長さ']);
  const numericInput = el('input', {
    id: 'numeric-input',
    type: 'text',
    autocomplete: 'off',
    spellcheck: false,
  }, []);
  const numeric = el('form', { class: 'numeric', id: 'numeric', hidden: true }, [numericLabel, numericInput]);
  const canvasWrap = el('main', { class: 'canvas-wrap' }, [canvas, canvas3d, viewTabs, options, numeric]);
  const inspector = el('aside', { class: 'inspector', id: 'inspector', 'aria-label': 'プロパティ' }, []);
  const statusHint = el('span', { id: 'status-hint' }, []);
  const statusReadout = el('span', { id: 'status-readout' }, []);

  const root = el('div', { class: 'minicad' }, [
    el('header', { class: 'topbar' }, [
      el('div', { class: 'brand' }, [el('strong', {}, ['MiniCAD']), el('span', {}, ['間取りエディタ'])]),
      fileActions,
    ]),
    el('div', { class: 'workspace' }, [toolbar, canvasWrap, inspector]),
    el('footer', { class: 'statusbar' }, [statusHint, statusReadout]),
  ]);

  host.append(root);

  return {
    root, fileActions, toolbar, canvasWrap, canvas, canvas3d, viewTabs,
    options, numeric, numericLabel, numericInput, inspector, statusHint, statusReadout,
  };
}

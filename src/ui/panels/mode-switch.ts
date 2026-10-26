import { MODE_LABELS, MODES } from '../mode.ts';
import { clear, el } from '../dom.ts';
import type { Panel, PanelContext } from '../panel.ts';

/**
 * 通常モードとプロモードの切り替え。上部バーに置く。
 *
 * 切り替えで変わるのは**出すツールと出す区画だけ**で、図面は何も変わらない。
 * `ViewTabs` と同じく、ここはボタンを並べるだけにしてある。
 */
export class ModeSwitch implements Panel {
  constructor(private readonly host: HTMLElement) {}

  refresh(ctx: PanelContext): void {
    clear(this.host);
    this.host.append(el('span', { class: 'mode-label' }, ['編集モード']));
    for (const mode of MODES) {
      this.host.append(
        el('button', {
          type: 'button',
          'data-mode': mode,
          'aria-pressed': String(ctx.mode === mode),
          onclick: () => ctx.setMode(mode),
        }, [MODE_LABELS[mode]]),
      );
    }
  }
}

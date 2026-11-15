import { clear, el } from '../dom.ts';
import { icon } from '../icon.ts';
import type { Panel, PanelContext } from '../panel.ts';
import { PANE_IDS, PANE_SPECS, paneHasSections } from '../section-registry.ts';

/**
 * 右の欄に何の束を出すかを選ぶレール。
 *
 * **毎回建て直す。** モードや「閲覧のみ」で束ごと消えることがあるので、
 * 出し分けは `ViewTabs` と同じく建て直しで揃える。
 *
 * **中身が 1 つも無い束はボタンを出さない。** 押しても何も出ない口は
 * 壊れて見える（`file-actions.ts` と `level-switch.ts` が同じことを書いている）。
 *
 * **開いている束をもう一度押すと畳む。** 作図中に図面を広く見たいのは CAD の常で、
 * 畳むとキャンバスが 1036 → 1308px になる。ワイヤーには無いが Coohom にはある。
 */
export class PanelRail implements Panel {
  constructor(private readonly host: HTMLElement) {}

  refresh(ctx: PanelContext): void {
    clear(this.host);
    for (const id of PANE_IDS) {
      if (!paneHasSections(id, ctx.mode, ctx.can)) continue;
      const spec = PANE_SPECS[id];
      const open = ctx.pane === id;
      this.host.append(
        el(
          'button',
          {
            class: 'rail-button',
            type: 'button',
            'data-pane': id,
            'aria-pressed': String(open),
            title: open ? `${spec.label}を畳む` : spec.label,
            onclick: () => ctx.setPane(open ? null : id),
          },
          [icon(spec.icon, 20), el('span', { class: 'rail-label' }, [spec.label])],
        ),
      );
    }
  }
}

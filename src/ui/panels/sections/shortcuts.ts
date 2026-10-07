import { POINTER_HINTS, type Binding } from '../../keymap.ts';
import { el } from '../../dom.ts';
import type { Section, PanelContext } from '../../panel.ts';

/** キーバインドの表から一覧を作る。実装と表示がずれないのが狙い */
export class ShortcutsSection implements Section {
  constructor(private readonly bindings: Binding[]) {}

  render(ctx: PanelContext): (HTMLElement | null)[] {
    const rows: HTMLElement[] = [];
    const push = (display: string, description: string) => {
      rows.push(el('kbd', {}, [display]), el('span', {}, [description]));
    };

    const tools = ctx.editor.allTools();
    push(tools.map((t) => t.shortcut).join('/'), 'ツール切替');
    for (const b of this.bindings) {
      if (b.display && b.description) push(b.display, b.description);
    }
    for (const h of POINTER_HINTS) push(h.display, h.description);

    return [el('h2', {}, ['ショートカット']), el('div', { class: 'shortcut-list' }, rows)];
  }
}

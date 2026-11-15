import type { ToolGroup } from '../../tools/tool.ts';
import { clear, el } from '../dom.ts';
import { icon } from '../icon.ts';
import type { Panel, PanelContext } from '../panel.ts';

export class Toolbar implements Panel {
  constructor(private readonly host: HTMLElement) {}

  /** ツールの一覧は起動時に決まるので、ボタンは1度だけ作る */
  build(ctx: PanelContext): void {
    clear(this.host);
    let previousGroup: ToolGroup | undefined;

    for (const tool of ctx.editor.allTools()) {
      const group = tool.group ?? 'draw';
      if (previousGroup !== undefined && group !== previousGroup) {
        this.host.append(el('div', { class: 'tool-divider' }, []));
      }
      previousGroup = group;

      this.host.append(
        el(
          'button',
          {
            class: 'tool-button',
            type: 'button',
            title: tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label,
            'data-tool': tool.id,
            onclick: () => {
              ctx.selectTool(tool.id);
              ctx.editor.canvas.focus();
            },
          },
          [
            icon(tool.id, 20),
            /*
             * **名札にキーを焼き込む。** アイコンだけにすると、どの道具が
             * どのキーか画面から読めなくなる。Coohom も `Straight wall(B)`・
             * `Arc wall(H)` と名札にキーを入れている
             */
            el('span', { class: 'tool-name' }, [
              tool.label,
              tool.shortcut ? el('span', { class: 'key' }, [tool.shortcut]) : null,
            ]),
          ],
        ),
      );
    }
  }

  refresh(ctx: PanelContext): void {
    for (const button of this.host.querySelectorAll<HTMLButtonElement>('.tool-button')) {
      button.setAttribute('aria-pressed', String(button.dataset.tool === ctx.editor.activeToolId));
    }
  }
}

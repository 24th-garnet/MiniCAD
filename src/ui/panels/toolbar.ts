import type { ToolGroup } from '../../tools/tool.ts';
import { TOOL_REGISTRY } from '../tool-registry.ts';
import { clear, el } from '../dom.ts';
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
            title: `${tool.label} (${tool.shortcut})`,
            'data-tool': tool.id,
            onclick: () => {
              ctx.selectTool(tool.id);
              ctx.editor.canvas.focus();
            },
          },
          [
            el('span', { class: 'glyph' }, [TOOL_REGISTRY[tool.id].glyph]),
            el('span', {}, [tool.label]),
            el('span', { class: 'key' }, [tool.shortcut]),
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

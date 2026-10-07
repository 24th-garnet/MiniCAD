import { clear } from '../dom.ts';
import type { Panel, PanelContext, Section } from '../panel.ts';

/** セクションを順に並べるだけ。項目が増えたら配列に1行足す */
export class Inspector implements Panel {
  constructor(
    private readonly host: HTMLElement,
    private readonly sections: Section[],
  ) {}

  refresh(ctx: PanelContext): void {
    clear(this.host);
    for (const section of this.sections) {
      for (const node of section.render(ctx)) {
        if (node) this.host.append(node);
      }
    }
  }
}

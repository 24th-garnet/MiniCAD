import { clear } from '../dom.ts';
import type { Panel, PanelContext, Section } from '../panel.ts';

/** セクションを順に並べるだけ。何を並べるかは `section-registry.ts` が決める */
export class Inspector implements Panel {
  private sections: Section[];

  constructor(
    private readonly host: HTMLElement,
    sections: Section[],
  ) {
    this.sections = sections;
  }

  /** モードが変わったときに差し替える */
  setSections(sections: Section[]): void {
    this.sections = sections;
  }

  refresh(ctx: PanelContext): void {
    clear(this.host);
    for (const section of this.sections) {
      for (const node of section.render(ctx)) {
        if (node) this.host.append(node);
      }
    }
  }
}

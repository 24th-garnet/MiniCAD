import { el, readonlyField } from '../../dom.ts';
import type { Section, PanelContext } from '../../panel.ts';

export class StatsSection implements Section {
  render(ctx: PanelContext): (HTMLElement | null)[] {
    const scene = ctx.editor.store.scene;
    return [
      el('h2', {}, ['図面']),
      readonlyField('壁', `${Object.keys(scene.walls).length} 本`),
      readonlyField('開口部', `${Object.keys(scene.openings).length} 箇所`),
      readonlyField('ブロック', `${Object.keys(scene.instances).length} 個`),
      readonlyField('図形', `${Object.keys(scene.shapes).length} 個`),
    ];
  }
}

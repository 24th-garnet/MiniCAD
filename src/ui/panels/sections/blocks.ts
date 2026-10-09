import { blockUsageCount, purgeUnusedBlocks } from '../../../core/block.ts';
import { el, readonlyField } from '../../dom.ts';
import type { Section, PanelContext } from '../../panel.ts';

/** ブロック定義の一覧。DXF の BLOCKS テーブルに対応する */
export class BlocksSection implements Section {
  render(ctx: PanelContext): (HTMLElement | null)[] {
    const scene = ctx.editor.store.scene;
    const defs = Object.values(scene.blocks);
    const used = defs.filter((d) => blockUsageCount(scene, d.id) > 0);
    const unusedUser = defs.filter((d) => d.source === 'user' && blockUsageCount(scene, d.id) === 0);

    const out: (HTMLElement | null)[] = [
      el('h2', {}, ['ブロック']),
      readonlyField('定義', `${defs.length} 種（使用中 ${used.length}）`),
    ];

    if (used.length === 0) {
      out.push(el('p', { class: 'empty-note' }, ['まだ何も置かれていません。']));
    } else {
      const list = el('ul', { class: 'room-list' }, []);
      for (const def of used) {
        list.append(
          el('li', {}, [
            el('span', {}, [def.label]),
            el('span', {}, [`${blockUsageCount(scene, def.id)} 個 / ${def.name}`]),
          ]),
        );
      }
      out.push(list);
    }

    if (unusedUser.length > 0) {
      out.push(
        el(
          'button',
          {
            class: 'wide',
            type: 'button',
            title: 'どこからも使われていない定義を消す',
            onclick: () => ctx.edit(() => purgeUnusedBlocks(scene).length > 0),
          },
          [`使っていない定義を消す（${unusedUser.length} 種）`],
        ),
      );
    }
    return out;
  }
}

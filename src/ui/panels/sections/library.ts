import { BlockInsertTool } from '../../../tools/block-insert.ts';
import { el } from '../../dom.ts';
import type { PanelContext, Section } from '../../panel.ts';
import type { LibraryItem } from '../../../host.ts';

/**
 * 挿せる部品の一覧。**通常モードの中心にある道具立て。**
 *
 * ワイヤーの通常モードは、建築パーツをパレットから選んで置く形
 * （ペイント・建具・構造…）。その受け皿をここに作る。中身を増やすのは次の段で、
 * 置き場所を先に作っておかないとパレットを 2 回作ることになる。
 *
 * **カタログのマスタはホストが持つ。** 検索も公開もいいねも DL 数もホストの
 * 仕事で、ここは絞り込み済みの一覧を受け取って挿すだけ。ホストが何も渡さないときは、
 * 図面が持っているブロック定義をそのまま出す（単体でも空にならない）。
 */
export class LibrarySection implements Section {
  render(ctx: PanelContext): (HTMLElement | null)[] {
    const items = ctx.catalogs.library ?? fromScene(ctx);
    const out: (HTMLElement | null)[] = [el('h2', {}, ['パーツ'])];

    if (items.length === 0) {
      out.push(el('p', { class: 'empty-note' }, ['挿せる部品がありません。']));
      return out;
    }

    for (const [category, group] of groupBy(items)) {
      if (category) out.push(el('h3', { class: 'part-group' }, [category]));
      const grid = el('div', { class: 'part-grid' }, []);
      for (const item of group) grid.append(partButton(item, ctx));
      out.push(grid);
    }

    // **持っていないものは、持っていないと書く**
    const stamps = items.filter((i) => !i.block && i.scene).length;
    if (stamps > 0) {
      out.push(el('p', { class: 'warn-note' }, [
        `壁を含む部品が ${stamps} 件ありますが、まだ挿せません。`
        + 'ブロック定義には壁と建具を入れられないため、別の仕組み（実体への展開）が要ります。',
      ]));
    }
    const materials = ctx.catalogs.materials?.length ?? 0;
    if (materials > 0) {
      out.push(el('p', { class: 'empty-note' }, [
        `素材カタログを ${materials} 件受け取っていますが、まだ誰も読んでいません。`,
      ]));
    }
    return out;
  }
}

function partButton(item: LibraryItem, ctx: PanelContext): HTMLElement {
  const def = item.block;
  if (!def) {
    return el('button', {
      class: 'part-button',
      type: 'button',
      disabled: true,
      title: '壁を含む部品はまだ挿せません',
    }, [item.label]);
  }
  return el('button', {
    class: 'part-button',
    type: 'button',
    title: `${item.label}  ${def.size.w}×${def.size.h}`,
    onclick: () => insert(ctx, def.id, item),
  }, [item.label]);
}

/**
 * 部品を選んで、置ける状態にする。
 *
 * **新しい挿入の経路は作らない。** 図面にまだ無い定義だけ足して、あとは
 * 既存のブロックツールに渡す。ゴーストも壁沿わせも回転も undo も、
 * ツールが既に持っているものがそのまま効く。
 */
function insert(ctx: PanelContext, blockId: string, item: LibraryItem): void {
  const scene = ctx.editor.store.scene;
  if (!scene.blocks[blockId] && item.block) {
    ctx.edit(() => void (scene.blocks[blockId] = structuredClone(item.block!)));
  }
  ctx.selectTool('block');
  const tool = ctx.editor.tool;
  if (tool instanceof BlockInsertTool) tool.blockId = blockId;
  ctx.editor.canvas.focus();
  ctx.refresh();
}

/** ホストがカタログを渡さないときの既定。図面が持っている定義を出す */
function fromScene(ctx: PanelContext): LibraryItem[] {
  return Object.values(ctx.editor.store.scene.blocks).map((def) => ({
    id: def.id,
    label: def.label,
    block: def,
  }));
}

/** 見出しごとにまとめる。見出しが無いものは先頭に 1 つの束で出す */
function groupBy(items: LibraryItem[]): [string, LibraryItem[]][] {
  const groups = new Map<string, LibraryItem[]>();
  for (const item of items) {
    const key = item.category ?? '';
    const got = groups.get(key);
    if (got) got.push(item);
    else groups.set(key, [item]);
  }
  return [...groups];
}

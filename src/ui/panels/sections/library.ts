import { BlockInsertTool } from '../../../tools/block-insert.ts';
import { FIXTURE_KINDS, FIXTURE_SPECS, type FixtureKind } from '../../../core/fixture.ts';
import { FixtureTool } from '../../../tools/fixture.ts';
import { OpeningTool } from '../../../tools/opening.ts';
import type { Bay } from '../../../core/bay.ts';
import type { OpeningKind } from '../../../core/types.ts';
import { OPENING_SYMBOLS } from '../../../core/opening.ts';
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

    // **構造を先に出す**（ワイヤーの奥谷さんの指摘）。躯体を決めてから
    // 建具を入れ、最後に家具を置く——実際の手順の順に並べる
    out.push(el('h3', { class: 'part-group' }, ['構造']));
    const structure = el('div', { class: 'part-grid' }, []);
    for (const kind of FIXTURE_KINDS) structure.append(fixtureButton(kind, ctx));
    out.push(structure);

    // **建具は構造の次。** 躯体 → 建具 → 家具 の順
    out.push(el('h3', { class: 'part-group' }, ['建具']));
    const openings = el('div', { class: 'part-grid' }, []);
    for (const preset of OPENING_PARTS) openings.append(openingButton(preset, ctx));
    out.push(openings);

    if (items.length === 0) return out;

    for (const [category, group] of groupBy(items)) {
      out.push(el('h3', { class: 'part-group' }, [category || '家具']));
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

/** 構造物を選ぶ。種別はツールが持っているので、渡して切り替えるだけ */
function fixtureButton(kind: FixtureKind, ctx: PanelContext): HTMLElement {
  const spec = FIXTURE_SPECS[kind];
  const active = ctx.editor.activeToolId === 'fixture' && currentKind(ctx) === kind;
  return el('button', {
    class: 'part-button',
    type: 'button',
    'aria-pressed': String(active),
    'data-fixture': kind,
    title: `${spec.label}  ${spec.defaultSize.w}×${spec.defaultSize.h}`,
    onclick: () => {
      ctx.selectTool('fixture');
      const tool = ctx.editor.tool;
      if (tool instanceof FixtureTool) tool.kind = kind;
      ctx.editor.canvas.focus();
      ctx.refresh();
    },
  }, [spec.label]);
}

/**
 * 建具のパレット。**種別と張り出しの組み合わせ**で並べる。
 *
 * ワイヤーは「窓 / 出窓 / ハーフ出窓」を別々の部品として並べているが、
 * JIS の平面では全部同じ記号なので、`OpeningKind` は増やさない。
 * 違うのは張り出し（`Bay`）と窓台の高さだけ。
 */
interface OpeningPart {
  label: string;
  family: 'door' | 'window';
  kind: OpeningKind;
  bay?: Bay;
}

const OPENING_PARTS: OpeningPart[] = [
  { label: 'ドア', family: 'door', kind: 'door' },
  { label: '引き違い窓', family: 'window', kind: 'windowSliding' },
  { label: '窓', family: 'window', kind: 'window' },
  { label: '壁開口', family: 'door', kind: 'opening' },
  { label: '出窓', family: 'window', kind: 'window', bay: { shape: 'box', depth: 450, side: 1 } },
  { label: 'ニッチ', family: 'door', kind: 'opening', bay: { shape: 'box', depth: -150, side: 1 } },
];

function openingButton(part: OpeningPart, ctx: PanelContext): HTMLElement {
  return el('button', {
    class: 'part-button',
    type: 'button',
    'data-opening': part.label,
    title: part.label,
    onclick: () => {
      ctx.selectTool(part.family);
      const tool = ctx.editor.tool;
      if (tool instanceof OpeningTool) {
        tool.kind = part.kind;
        // 種別を変えたら幅もその種別の既定に戻す。ツールの種別セレクタと同じ扱い
        tool.width = OPENING_SYMBOLS[part.kind].defaultWidth;
        tool.bay = part.bay ? { ...part.bay } : null;
      }
      ctx.editor.canvas.focus();
      ctx.refresh();
    },
  }, [part.label]);
}

function currentKind(ctx: PanelContext): FixtureKind | null {
  const tool = ctx.editor.tool;
  return tool instanceof FixtureTool ? tool.kind : null;
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

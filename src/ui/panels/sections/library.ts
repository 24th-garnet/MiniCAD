import { BlockInsertTool } from '../../../tools/block-insert.ts';
import { FIXTURE_SPECS, fixtureKindsOf, type FixtureKind } from '../../../core/fixture.ts';
import { FixtureTool } from '../../../tools/fixture.ts';
import { OpeningTool } from '../../../tools/opening.ts';
import type { Bay } from '../../../core/bay.ts';
import type { OpeningKind } from '../../../core/types.ts';
import { OPENING_SYMBOLS } from '../../../core/opening.ts';
import { assemblyFromScene } from '../../../core/assembly.ts';
import { AssemblyTool } from '../../../tools/assembly.ts';
import { deserialize } from '../../../io/scene.ts';
import { el } from '../../dom.ts';
import type { PanelContext, Section } from '../../panel.ts';
import type { LibraryItem } from '../../../host.ts';
import { ALL_USES, USES, USE_LABELS, type Use } from '../../../core/use.ts';

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
  /**
   * 絞り込み中の物件用途。null は「全て」。
   *
   * **区画のインスタンスが持つ。** 図面の中身ではないので履歴にも載せず、
   * 保存もしない。区画はモードを切り替えたときにだけ作り直されるので、
   * パネルを描き直しても選んだ用途は残る。
   */
  private use: Use | null = null;

  render(ctx: PanelContext): (HTMLElement | null)[] {
    const items = ctx.catalogs.library ?? fromScene(ctx);
    const out: (HTMLElement | null)[] = [el('h2', {}, ['パーツ'])];
    out.push(this.useFilter(ctx));

    // **構造を先に出す**（ワイヤーの奥谷さんの指摘）。躯体を決めてから
    // 建具を入れ、最後に家具を置く——実際の手順の順に並べる
    // **建築の躯体だけ。** 汎用ソリッドはプロモードの「ソリッド」ツールから出す
    const fixtures = fixtureKindsOf('structure').filter((k) => this.shows(FIXTURE_SPECS[k].uses));
    if (fixtures.length > 0) {
      out.push(el('h3', { class: 'part-group' }, ['構造']));
      const structure = el('div', { class: 'part-grid' }, []);
      for (const kind of fixtures) structure.append(fixtureButton(kind, ctx));
      out.push(structure);
    }

    // **建具は構造の次。** 躯体 → 建具 → 家具 の順
    const parts = OPENING_PARTS.filter((p) => this.shows(p.uses));
    if (parts.length > 0) {
      out.push(el('h3', { class: 'part-group' }, ['建具']));
      const openings = el('div', { class: 'part-grid' }, []);
      for (const preset of parts) openings.append(openingButton(preset, ctx));
      out.push(openings);
    }

    if (items.length === 0) return out;

    for (const [category, group] of groupBy(items)) {
      out.push(el('h3', { class: 'part-group' }, [category || '家具']));
      const grid = el('div', { class: 'part-grid' }, []);
      for (const item of group) grid.append(partButton(item, ctx));
      out.push(grid);
    }

    const stamps = items.filter((i) => !i.block && i.scene).length;
    if (stamps > 0) {
      out.push(el('p', { class: 'empty-note' }, [
        `壁を含む部品が ${stamps} 件あります。置くと壁や建具そのものになります`
        + '（入れ子にはなりません）。',
      ]));
    }
    const materials = ctx.catalogs.materials ?? [];
    if (materials.length > 0) {
      const textured = materials.filter((m) => m.texture).length;
      out.push(el('p', { class: 'empty-note' }, [
        `素材 ${materials.length} 件。選んだものに当てるには、`
        + '図面で選んでからプロパティの「素材」で指定します。'
        + (textured > 0 ? `うち ${textured} 件はテクスチャを持っていますが、まだ使っていません。` : ''),
      ]));
    }
    return out;
  }

  /** その用途でよく使うものか。「全て」のときは何も落とさない */
  private shows(uses: readonly Use[]): boolean {
    return this.use === null || uses.includes(this.use);
  }

  /**
   * 物件用途のラジオ。ワイヤー改訂版の画面上部にあるもの。
   *
   * **ホストのカタログは絞らない。** ホストが渡す家具の一覧には用途の札が
   * 無く、勝手に札を立てると「渡したのに出ない」が起きる。
   * 絞るのは MiniCAD が持っている建築パーツだけ。
   */
  private useFilter(ctx: PanelContext): HTMLElement {
    const row = el('div', { class: 'use-filter' }, []);
    const button = (value: Use | null, label: string): HTMLElement =>
      el('button', {
        class: 'use-button',
        type: 'button',
        'aria-pressed': String(this.use === value),
        'data-use': value ?? 'all',
        onclick: () => {
          this.use = value;
          ctx.refresh();
        },
      }, [label]);
    row.append(button(null, '全て'));
    for (const use of USES) row.append(button(use, USE_LABELS[use]));
    return row;
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
  /** 既定の開口幅 (mm)。省くと種別の既定 */
  width?: number;
  /** 既定の枚数。省くと種別の既定 */
  leaves?: number;
  /** 既定の窓台 (mm)。掃き出し窓は 0、腰窓は 800 */
  sillHeight?: number;
  /** 既定の建具高さ (mm) */
  height?: number;
  /** 既定の建具符号 */
  designation?: string;
  /**
   * 角に置く L 型出窓か。**壁ではなく角をクリックする。**
   *
   * 角をまたぐものは `Opening` 1 つでは表せない（窓 2 つ ＋ L 字の張り出し
   * 1 つになる）ので、`OpeningKind` は増やさずにここで分ける。
   */
  corner?: boolean;
  /** どの物件用途でよく使うか（ワイヤー 8 枚目のタグ） */
  uses: readonly Use[];
}

/**
 * ワイヤー改訂版（8 枚目）のパーツ表。**ドア 11 品・窓 9 品・出窓 5 品。**
 *
 * ここに並ぶのは品であって種別ではない。`OpeningKind` は 10 種のままで、
 * 1 品は「種別 ＋ 既定幅 ＋ 窓台 ＋ 枚数 ＋ 符号」の組で出る。
 * 使う人は「FIX窓を置く」と考えるので品名のボタンを出し、
 * 図面の中身は記号が同じものをまとめて持つ——**画面と内部でちょうど逆**にする。
 *
 * **天窓はここに無い。** 壁に付かないので `Opening` では表せず、
 * 吹抜と同じ「水平面に置く部品」として**構造の側**に置いてある。
 */
const OPENING_PARTS: OpeningPart[] = [
  // ドア
  { label: '開き戸(片開き)', family: 'door', kind: 'door', uses: ALL_USES },
  { label: '開き戸(両開き)', family: 'door', kind: 'doubleDoor', uses: ALL_USES },
  { label: '開き戸(3枚開き)', family: 'door', kind: 'door', width: 2400, leaves: 3, uses: ALL_USES },
  { label: '開き戸(親子ドア)', family: 'door', kind: 'unequalDoor', uses: ['住'] },
  { label: '引き戸(片開き)', family: 'door', kind: 'slidingSingle', uses: ['住', '店'] },
  { label: '引き戸(両開き)', family: 'door', kind: 'slidingDouble', uses: ['住', '店'] },
  { label: '引き戸(4枚開き)', family: 'door', kind: 'slidingDouble', width: 3300, leaves: 4, uses: ['住'] },
  { label: '引き戸(大開口)', family: 'door', kind: 'slidingDouble', width: 3600, uses: ['店'] },
  { label: '引込み戸', family: 'door', kind: 'slidingPocket', uses: ['住', '店'] },
  { label: '折れ戸(4枚)', family: 'door', kind: 'folding', uses: ['住'] },
  { label: '折れ戸(大開口)', family: 'door', kind: 'folding', width: 2700, leaves: 6, uses: ['店'] },
  // 勝手口は外部建具。幅が狭く、符号が付く
  { label: '勝手口ドア', family: 'door', kind: 'door', width: 700, designation: 'AD-1', uses: ['住'] },
  { label: 'ドア開口(建具なし)', family: 'door', kind: 'opening', uses: ALL_USES },

  // 窓。記号は同じで、窓台と符号で分かれる
  { label: '引き違い窓', family: 'window', kind: 'windowSliding', sillHeight: 800, uses: ALL_USES },
  { label: '掃き出し窓', family: 'window', kind: 'windowSliding', width: 1700, sillHeight: 0, height: 2000, uses: ALL_USES },
  { label: '片開き窓', family: 'window', kind: 'window', width: 600, sillHeight: 800, designation: 'AW-1', uses: ALL_USES },
  { label: '上げ下げ窓', family: 'window', kind: 'window', width: 600, sillHeight: 900, designation: 'AW-2', uses: ['住', '店'] },
  { label: 'FIX窓', family: 'window', kind: 'window', width: 900, sillHeight: 900, designation: 'FIX', uses: ['オ', '店'] },
  { label: '排煙窓', family: 'window', kind: 'window', width: 900, sillHeight: 1800, designation: 'HW-1', uses: ['オ', '店'] },
  { label: '横連窓', family: 'window', kind: 'window', width: 3600, sillHeight: 900, height: 1200, designation: 'AW-3', uses: ['オ', '店'] },
  // 丸窓だけは記号が違うので種別がある。**3D と立面の穴は矩形のまま**
  { label: 'FIX窓(丸窓)', family: 'window', kind: 'windowRound', width: 600, sillHeight: 1200, designation: 'FIX', uses: ['住', '店'] },

  // 出窓。窓に張り出しを足したもの
  { label: '角型出窓', family: 'window', kind: 'window', sillHeight: 800, bay: { shape: 'box', depth: 450, side: 1 }, uses: ['住'] },
  { label: '台形出窓', family: 'window', kind: 'window', sillHeight: 800, bay: { shape: 'trapezoid', depth: 450, side: 1 }, uses: ['住'] },
  { label: '弓型出窓', family: 'window', kind: 'window', sillHeight: 800, bay: { shape: 'bow', depth: 450, side: 1 }, uses: ['住'] },
  // ハーフ出窓は窓台が高いだけ。欄は増やさない
  { label: 'ハーフ出窓', family: 'window', kind: 'window', sillHeight: 1100, bay: { shape: 'box', depth: 300, side: 1 }, uses: ['住'] },
  // L 型出窓は角に置く。窓 2 つ ＋ L 字の張り出し 1 つになる
  { label: 'L型出窓', family: 'window', kind: 'window', width: 1200, sillHeight: 800, bay: { shape: 'box', depth: 450, side: 1 }, corner: true, uses: ['住'] },
  { label: 'ニッチ', family: 'door', kind: 'opening', bay: { shape: 'box', depth: -150, side: 1 }, uses: ALL_USES },
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
        const symbol = OPENING_SYMBOLS[part.kind];
        tool.kind = part.kind;
        // **品の既定値をひとそろい流し込む。** 省いた欄は種別の既定に戻す。
        // 戻さないと、前に押した品の窓台や符号が次の品に残る
        tool.width = part.width ?? symbol.defaultWidth;
        tool.leaves = part.leaves ?? symbol.defaultLeaves;
        tool.sillHeight = part.sillHeight ?? null;
        tool.height = part.height ?? null;
        tool.designation = part.designation ?? '';
        tool.bay = part.bay ? { ...part.bay } : null;
        // **角に置くかどうかも戻す。** 戻さないと、L 型出窓を押した後に
        // 普通の窓を押しても角モードのままになる
        tool.corner = part.corner === true;
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
    // **壁を含む部品はシンボルとして置く。** 置いた瞬間に実体へ展開されるので、
    // 部屋検出も DXF も無改造で効く
    if (!item.scene) {
      return el('button', {
        class: 'part-button', type: 'button', disabled: true,
        title: '中身がありません',
      }, [item.label]);
    }
    return el('button', {
      class: 'part-button',
      type: 'button',
      title: `${item.label}（置くと壁や建具そのものになります）`,
      onclick: () => insertAssembly(ctx, item),
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

/**
 * 壁を含む部品を置けるようにする。**図面にシンボルとして取り込んでから**
 * シンボルツールに渡す。新しい挿入の経路は作らない。
 */
function insertAssembly(ctx: PanelContext, item: LibraryItem): void {
  const scene = ctx.editor.store.scene;
  const id = `host-${item.id}`;
  if (!scene.assemblies[id]) {
    const made = assemblyFromScene(deserialize(item.scene!), id, item.label);
    if (!made) {
      window.alert('この部品には壁も構造も入っていません。');
      return;
    }
    ctx.edit(() => void (scene.assemblies[id] = made));
  }
  ctx.selectTool('assembly');
  const tool = ctx.editor.tool;
  if (tool instanceof AssemblyTool) tool.assemblyId = id;
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

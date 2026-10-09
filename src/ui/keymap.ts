import { downloadJson } from '../io/scene.ts';
import { isSelectable } from '../core/entity.ts';
import type { CommandInput } from './command-input.ts';
import { isTextInput } from './editor.ts';
import type { PanelContext } from './panel.ts';

/**
 * キーバインドの表。
 * ショートカット一覧はこの表から生成するので、実装と表示がずれない。
 */
export interface Binding {
  keys: string[];
  /** Cmd / Ctrl を要求する */
  mod?: boolean;
  /** Shift の有無を指定する。省略すると問わない */
  shift?: boolean;
  /** 一覧に出す表記。省略すると一覧に出ない */
  display?: string;
  description?: string;
  run(ctx: PanelContext): void;
}

export function defaultBindings(): Binding[] {
  return [
    {
      keys: ['z', 'Z'],
      mod: true,
      shift: false,
      display: 'Cmd/Ctrl+Z',
      description: '元に戻す',
      run: (ctx) => ctx.editor.store.undo(),
    },
    {
      keys: ['z', 'Z'],
      mod: true,
      shift: true,
      display: 'Shift+Cmd/Ctrl+Z',
      description: 'やり直す',
      run: (ctx) => ctx.editor.store.redo(),
    },
    { keys: ['y', 'Y'], mod: true, run: (ctx) => ctx.editor.store.redo() },
    { keys: ['s', 'S'], mod: true, run: (ctx) => downloadJson(ctx.editor.store.scene) },
    {
      keys: ['a', 'A'],
      mod: true,
      display: 'Cmd/Ctrl+A',
      description: 'すべて選択',
      run: (ctx) => {
        const scene = ctx.editor.store.scene;
        const all = [
          ...Object.keys(scene.walls).map((id) => ({ type: 'wall' as const, id })),
          ...Object.keys(scene.instances).map((id) => ({ type: 'blockInstance' as const, id })),
          ...Object.keys(scene.openings).map((id) => ({ type: 'opening' as const, id })),
        ];
        ctx.editor.store.setSelection(all.filter((ref) => isSelectable(scene, ref)));
      },
    },
    {
      keys: ['Escape'],
      display: 'Esc',
      description: '取り消し・選択解除',
      run: (ctx) => {
        const editor = ctx.editor;
        if (editor.tool.isActive?.(editor)) editor.tool.cancel?.(editor);
        else if (editor.store.selection.length > 0) editor.store.clearSelection();
        else editor.setTool('select');
      },
    },
    {
      keys: ['Delete', 'Backspace'],
      display: 'Delete',
      description: '選択を削除',
      run: (ctx) => ctx.deleteSelection(),
    },
    { keys: ['0'], display: '0', description: '全体表示', run: (ctx) => ctx.editor.zoomToFit() },
    {
      keys: ['g', 'G'],
      display: 'G',
      description: 'グリッドスナップ',
      run: (ctx) => ctx.set(() => void (ctx.editor.store.settings.snapGrid = !ctx.editor.store.settings.snapGrid)),
    },
    {
      keys: ['F8'],
      display: 'F8',
      description: '直交・角度スナップ',
      run: (ctx) => ctx.set(() => void (ctx.editor.store.settings.ortho = !ctx.editor.store.settings.ortho)),
    },
  ];
}

/** キー以外の操作。ショートカット一覧に並べるためだけのもの */
export const POINTER_HINTS: { display: string; description: string }[] = [
  { display: 'ドラッグ', description: '移動・範囲選択' },
  { display: '中ドラッグ / Space', description: '画面移動' },
  { display: 'ホイール', description: '拡大縮小' },
  { display: '矢印キー', description: '選択を微調整' },
  { display: '[ ]', description: '家具を回転' },
];

export function installKeymap(ctx: PanelContext, bindings: Binding[], commandInput: CommandInput): void {
  window.addEventListener('keydown', (e) => {
    if (isTextInput(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;

    // 作図中に数字や座標の記号を打ったら、そのまま入力欄へ流し込む
    // （`@` や `<` を忘れると相対・極座標が打てなくなる）
    if (!mod && /^[0-9.,<@-]$/.test(e.key) && commandInput.visible) {
      commandInput.beginWith(e.key);
      e.preventDefault();
      return;
    }

    // ツールの処理が最優先
    if (ctx.editor.tool.onKeyDown?.(ctx.editor, e)) {
      e.preventDefault();
      ctx.refresh();
      return;
    }

    for (const b of bindings) {
      if (Boolean(b.mod) !== mod) continue;
      if (b.shift !== undefined && b.shift !== e.shiftKey) continue;
      if (!b.keys.includes(e.key)) continue;
      e.preventDefault();
      b.run(ctx);
      ctx.refresh();
      return;
    }
    if (mod) return;

    const tool = ctx.editor.allTools().find((t) => t.shortcut.toLowerCase() === e.key.toLowerCase());
    if (tool) {
      e.preventDefault();
      ctx.editor.setTool(tool.id);
    }
  });
}

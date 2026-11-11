import { levelsInOrder, type Level } from '../../../core/level.ts';
import {
  addLevel,
  countOnLevel,
  levelRemovalBlocker,
  removeLevel,
  renameLevel,
  setActiveLevel,
} from '../../../core/levelOps.ts';
import { el } from '../../dom.ts';
import { dialogText, openDialog } from '../../dialog.ts';
import type { Section, PanelContext } from '../../panel.ts';

/**
 * 階。
 *
 * **2D は作業中の階だけを描く**ので、階を足す・名前を変える・消すがここに無いと、
 * 2 階建ての物件を通しで起こせない。データは前から複数階を持てていた。
 *
 * 並びは**上の階が上**。床高の順を逆に出すので、建物を横から見た並びになる。
 * 切り替えは図面の左上にもある（`LevelSwitch`）——そちらが普段使い、
 * ここは階そのものを触るところ。
 */
export class LevelsSection implements Section {
  render(ctx: PanelContext): (HTMLElement | null)[] {
    const scene = ctx.editor.store.scene;
    const out: (HTMLElement | null)[] = [el('h2', {}, ['階'])];

    for (const level of levelsInOrder(scene).reverse()) out.push(levelRow(level, ctx));

    if (ctx.can.edit) {
      out.push(
        el('div', { class: 'level-add' }, [
          el('button', {
            type: 'button',
            title: '最上階の上に足す（床高は最上階の床高＋階高）',
            onclick: () => addHere(ctx, 'above'),
          }, ['＋ 上に足す']),
          el('button', {
            type: 'button',
            title: '最下階の下に足す（地下）',
            onclick: () => addHere(ctx, 'below'),
          }, ['＋ 下に足す']),
        ]),
      );
    }
    return out;
  }
}

/** 足したらその階へ移る。足しておいて別の階に居続ける理由が無い */
function addHere(ctx: PanelContext, where: 'above' | 'below'): void {
  const scene = ctx.editor.store.scene;
  ctx.edit(() => {
    const level = addLevel(scene, where);
    scene.activeLevelId = level.id;
    ctx.editor.store.selection = [];
  });
  ctx.refresh();
}

function levelRow(level: Level, ctx: PanelContext): HTMLElement {
  const store = ctx.editor.store;
  const scene = store.scene;
  const active = scene.activeLevelId === level.id;
  const canEdit = ctx.can.edit;

  const pick = el('button', {
    type: 'button',
    class: 'level-pick',
    'aria-pressed': String(active),
    title: 'この階で作図する',
    onclick: () => {
      // 立ち位置なので履歴には残さない（`LevelSwitch` と同じ）
      ctx.set(() => {
        if (!setActiveLevel(scene, level.id)) return;
        store.selection = [];
      });
      ctx.refresh();
    },
  }, [active ? '●' : '○']);

  const name = el('input', {
    class: 'level-name',
    type: 'text',
    value: level.name,
    disabled: !canEdit,
  });
  name.addEventListener('change', () => {
    // 空名や重複は受け付けない。入力欄を元に戻して知らせる（画層と同じ作法）
    if (!renameLevel(scene, level.id, name.value)) {
      name.value = level.name;
      return;
    }
    ctx.edit(() => true);
    ctx.refresh();
  });
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') name.blur();
    e.stopPropagation();
  });

  const num = (
    title: string,
    value: number,
    apply: (v: number) => void,
  ): HTMLInputElement => {
    const input = el('input', {
      class: 'level-num',
      type: 'number',
      step: '100',
      title,
      value: String(Math.round(value)),
      disabled: !canEdit,
    });
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) {
        input.value = String(Math.round(value));
        return;
      }
      ctx.edit(() => apply(v));
      ctx.refresh();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      e.stopPropagation();
    });
    return input;
  };

  const cells: HTMLElement[] = [
    el('span', { class: 'level-unit' }, ['床高']),
    num('床の高さ (mm)。階の並び順はこの値で決まる', level.floorZ, (v) => void (level.floorZ = v)),
    el('span', { class: 'level-unit' }, ['階高']),
    // 0 以下の階高は壁が消える。1 mm で止める
    num('壁の既定の高さ (mm)', level.wallHeight, (v) => void (level.wallHeight = Math.max(1, v))),
  ];

  if (canEdit) {
    const n = countOnLevel(scene, level.id);
    cells.push(
      el('span', { class: 'level-count', title: 'この階に乗っているものの数' }, [`${n} 個`]),
      el('button', {
        class: 'level-delete',
        type: 'button',
        title: 'この階を消す（何か乗っていたら断ります）',
        onclick: () => {
          // **消せるかを先に訊く。** 一度消してみてから戻すと、
          // 戻し損ねたときに図面が静かに欠ける
          const blocker = levelRemovalBlocker(scene, level.id);
          if (blocker !== null) {
            openDialog('この階は消せません', [dialogText(blocker)], [
              { label: '閉じる', primary: true },
            ]);
            return;
          }
          ctx.edit(() => removeLevel(scene, level.id));
          ctx.refresh();
        },
      }, ['×']),
    );
  }

  return el('div', { class: 'level-row' }, [
    el('div', { class: 'level-head' }, [pick, name]),
    el('div', { class: 'level-controls' }, cells),
  ]);
}

import { levelsInOrder } from '../../core/level.ts';
import { setActiveLevel } from '../../core/levelOps.ts';
import { clear, el } from '../dom.ts';
import type { Panel, PanelContext } from '../panel.ts';

/**
 * 階の切り替え。図面の左上に置く。
 *
 * **2D は 1 枚の紙なので、どの階を見ているかが常に見えていないといけない。**
 * 選んだ階以外は描かれないため、どこにいるか分からないと「壁が消えた」と
 * しか見えない。`ViewTabs`（2D / 3D）の隣に、同じ押しボタンの作法で置く。
 *
 * **並びは下から上。** 床高の順なので、地下を足しても自分で左端へ回る。
 *
 * 階を増やす・名前を変える・消すのはインスペクタの「階」の区画。ここは
 * 切り替えだけに絞る——上部に欄を増やすと、いちばんよく使う操作が埋もれる。
 */
export class LevelSwitch implements Panel {
  constructor(private readonly host: HTMLElement) {}

  refresh(ctx: PanelContext): void {
    clear(this.host);
    const store = ctx.editor.store;
    const levels = levelsInOrder(store.scene);
    // 1 階しかないうちは出さない。押しても何も起きないボタンを置かない
    if (levels.length < 2) {
      this.host.hidden = true;
      return;
    }
    this.host.hidden = false;

    this.host.append(el('span', { class: 'level-label' }, ['階']));
    for (const level of levels) {
      this.host.append(
        el('button', {
          type: 'button',
          'data-level': level.id,
          'aria-pressed': String(store.scene.activeLevelId === level.id),
          title: `床高 ${level.floorZ} mm / 階高 ${level.wallHeight} mm`,
          onclick: () => {
            // **履歴には残さない。** どの階を見ているかは建物の形ではなく
            // 立ち位置で、undo で階が飛ぶと何を取り消したのか分からなくなる。
            // それでも図面には残る（`activeLevelId` は保存される）
            ctx.set(() => {
              if (!setActiveLevel(store.scene, level.id)) return;
              // **選択は持ち越さない。** 見えていないものが選ばれたままだと、
              // 次の操作が見えない場所に効く
              store.selection = [];
            });
            ctx.refresh();
          },
        }, [level.name]),
      );
    }
  }
}

import { toTatami } from '../../../core/rooms.ts';
import { el } from '../../dom.ts';
import type { Section, PanelContext } from '../../panel.ts';

/** 検出された部屋の一覧と合計面積 */
export class RoomsSection implements Section {
  render(ctx: PanelContext): (HTMLElement | null)[] {
    const rooms = ctx.editor.rooms;
    const innerArea = ctx.editor.store.settings.innerArea;
    const out: (HTMLElement | null)[] = [el('h2', {}, ['部屋'])];

    if (rooms.length === 0) {
      out.push(el('p', { class: 'empty-note' }, ['壁で囲まれた領域が部屋として自動認識されます。']));
      return out;
    }

    const list = el('ul', { class: 'room-list' }, []);
    let total = 0;
    let voids = 0;
    for (const room of rooms) {
      const area = innerArea ? room.innerArea : room.area;
      total += area;
      voids += room.voidArea;
      list.append(
        el('li', {}, [
          el('span', {}, [room.name ?? '(無名)']),
          el('span', {}, [`${area.toFixed(2)} m² / ${toTatami(area).toFixed(1)}帖`]),
        ]),
      );
    }
    list.append(
      el('li', {}, [
        el('span', {}, ['合計']),
        el('span', {}, [`${total.toFixed(2)} m² / ${toTatami(total).toFixed(1)}帖`]),
      ]),
    );
    out.push(list);
    if (voids > 0) {
      // **面積の欄は内法のまま。** 吹抜は床が無いだけで、部屋の広さは変わらない。
      // 床の面積が要るのは積算で、そちらには別の数字で渡している
      out.push(el('p', { class: 'empty-note' }, [
        `うち吹抜 ${voids.toFixed(2)} m²（床はありません）。`
        + `床面積の合計は ${(total - voids).toFixed(2)} m² です。`,
      ]));
    }
    return out;
  }
}

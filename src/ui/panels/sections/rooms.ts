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
    for (const room of rooms) {
      const area = innerArea ? room.innerArea : room.area;
      total += area;
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
    return out;
  }
}

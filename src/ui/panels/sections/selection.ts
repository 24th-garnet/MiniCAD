import { toDeg, toRad } from '../../../core/geometry.ts';
import { wallLength } from '../../../core/ops.ts';
import type { EntityRef } from '../../../core/types.ts';
import { checkboxField, el, numberField, readonlyField, selectField, textField } from '../../dom.ts';
import type { Section, PanelContext } from '../../panel.ts';

/** 選択中のエンティティのプロパティ */
export class SelectionSection implements Section {
  render(ctx: PanelContext): (HTMLElement | null)[] {
    const sel = ctx.editor.store.selection;
    const out: (HTMLElement | null)[] = [el('h2', {}, ['プロパティ'])];

    if (sel.length === 0) {
      out.push(el('p', { class: 'empty-note' }, ['何も選択されていません。']));
      return out;
    }
    if (sel.length > 1) {
      out.push(
        readonlyField('選択数', `${sel.length} 個`),
        el('button', { class: 'wide danger', type: 'button', onclick: () => ctx.deleteSelection() }, ['削除']),
      );
      return out;
    }

    out.push(...fieldsFor(ctx, sel[0]));
    out.push(
      el('button', { class: 'wide danger', type: 'button', onclick: () => ctx.deleteSelection() }, ['削除 (Delete)']),
    );
    return out;
  }
}

function fieldsFor(ctx: PanelContext, ref: EntityRef): HTMLElement[] {
  const scene = ctx.editor.store.scene;
  const edit = ctx.edit;

  switch (ref.type) {
    case 'wall': {
      const wall = scene.walls[ref.id];
      if (!wall) return [];
      return [
        readonlyField('種類', '壁'),
        readonlyField('長さ', `${Math.round(wallLength(scene, wall))} mm`),
        numberField('壁厚', wall.thickness, (v) => edit(() => void (wall.thickness = Math.max(10, v))), {
          step: 10,
          min: 10,
          suffix: 'mm',
        }),
      ];
    }
    case 'node': {
      const node = scene.nodes[ref.id];
      if (!node) return [];
      return [
        readonlyField('種類', '壁の端点'),
        numberField('X', node.x, (v) => edit(() => void (node.x = v)), { step: 100, suffix: 'mm' }),
        numberField('Y', node.y, (v) => edit(() => void (node.y = v)), { step: 100, suffix: 'mm' }),
      ];
    }
    case 'opening': {
      const op = scene.openings[ref.id];
      if (!op) return [];
      const wall = scene.walls[op.wallId];
      return [
        selectField(
          '種類',
          op.kind,
          [
            { value: 'door', label: 'ドア' },
            { value: 'window', label: '窓' },
            { value: 'opening', label: '開口のみ' },
          ],
          (v) => edit(() => void (op.kind = v as typeof op.kind)),
        ),
        numberField('幅', op.width, (v) => edit(() => void (op.width = Math.max(100, v))), { step: 50, suffix: 'mm' }),
        numberField('始点からの位置', op.offset, (v) => edit(() => void (op.offset = v)), { step: 50, suffix: 'mm' }),
        readonlyField('壁の長さ', wall ? `${Math.round(wallLength(scene, wall))} mm` : '-'),
        checkboxField('吊元を反転', op.flipX, (v) => edit(() => void (op.flipX = v))),
        checkboxField('開く向きを反転', op.flipY, (v) => edit(() => void (op.flipY = v))),
      ];
    }
    case 'furniture': {
      const f = scene.furniture[ref.id];
      if (!f) return [];
      return [
        textField('名前', f.name, (v) => edit(() => void (f.name = v))),
        numberField('幅', f.w, (v) => edit(() => void (f.w = Math.max(50, v))), { step: 50, suffix: 'mm' }),
        numberField('奥行', f.h, (v) => edit(() => void (f.h = Math.max(50, v))), { step: 50, suffix: 'mm' }),
        numberField('角度', toDeg(f.angle), (v) => edit(() => void (f.angle = toRad(v))), { step: 15, suffix: '°' }),
        numberField('X', f.x, (v) => edit(() => void (f.x = v)), { step: 50, suffix: 'mm' }),
        numberField('Y', f.y, (v) => edit(() => void (f.y = v)), { step: 50, suffix: 'mm' }),
      ];
    }
    case 'roomLabel': {
      const label = scene.roomLabels[ref.id];
      if (!label) return [];
      return [textField('部屋名', label.name, (v) => edit(() => void (label.name = v)))];
    }
  }
}

import { sceneBounds } from '../../../core/entity.ts';
import { centerSheetOn, fitsInFrame, jisMargins, paperDimensions } from '../../../core/sheet.ts';
import { PAPER_SIZES } from '../../../core/standard.ts';
import { checkboxField, el, numberField, readonlyField, selectField, textField } from '../../dom.ts';
import type { Section, PanelContext } from '../../panel.ts';

/** 用紙枠と表題欄。図面の属性なので変更は履歴に残す */
export class SheetSection implements Section {
  render(ctx: PanelContext): (HTMLElement | null)[] {
    const scene = ctx.editor.store.scene;
    const sheet = scene.sheet;
    const std = scene.standard;
    const edit = ctx.edit;
    const paper = paperDimensions(std);
    const margins = sheet.margins ?? jisMargins(std.paperId);
    const fit = fitsInFrame(sceneBounds(scene), sheet, std);

    return [
      el('h2', {}, ['用紙と表題欄']),
      checkboxField('用紙枠を表示', sheet.show, (v) =>
        edit(() => {
          sheet.show = v;
          // 初めて出すときは図面の中央に合わせる
          if (v) sheet.origin = centerSheetOn(sceneBounds(scene), sheet, std);
        }),
      ),
      selectField(
        '用紙 (JIS Z 8311)',
        std.paperId,
        PAPER_SIZES.map((p) => ({ value: p.id, label: p.label })),
        (v) => edit(() => void (std.paperId = v)),
      ),
      selectField(
        '向き',
        std.orientation,
        [
          { value: 'landscape', label: '横' },
          { value: 'portrait', label: '縦' },
        ],
        (v) => edit(() => void (std.orientation = v === 'portrait' ? 'portrait' : 'landscape')),
      ),
      readonlyField('用紙の実寸', `${paper.w} × ${paper.h} mm`),
      readonlyField('余白 / とじ代', `${margins.top} mm / ${margins.binding} mm`),
      fit.fits
        ? readonlyField('収まり', '輪郭内に収まっています')
        : el('p', { class: 'warn-note' }, [
            fit.suggestedScale
              ? `1:${std.scale} では ${std.paperId} に収まりません（1:${fit.suggestedScale} なら収まります）`
              : `1:${std.scale} では ${std.paperId} に収まりません`,
          ]),
      el(
        'button',
        {
          class: 'wide',
          type: 'button',
          onclick: () => edit(() => void (sheet.origin = centerSheetOn(sceneBounds(scene), sheet, std))),
        },
        ['図面の中央に用紙を合わせる'],
      ),
      // **用紙を好きな位置へ動かす**（ワイヤー 7 枚目の「用紙移動」）。
      // これまでは「図面の中央に合わせる」しか無く、中央が気に入らないときに
      // 動かす手段が無かった。`Sheet.origin` は前からあるので、欄を出すだけ。
      //
      // **ドラッグではなく数値で動かす。** 用紙枠を掴めるようにすると、
      // 選択ツールが「掴んで動かす」ものをもう 1 つ持つことになり、
      // **図面を動かすつもりが用紙を動かしていた**という取り違えが起きる
      // （頂点編集を別ツールにしたのと同じ理由）。用紙の位置は一度決めたら
      // ほとんど動かさないので、数値のほうが合っている。
      numberField('用紙の左下 X', sheet.origin.x, (v) => edit(() => void (sheet.origin.x = v)), {
        step: 10, suffix: 'mm',
      }),
      numberField('用紙の左下 Y', sheet.origin.y, (v) => edit(() => void (sheet.origin.y = v)), {
        step: 10, suffix: 'mm',
      }),

      checkboxField('表題欄を出す', sheet.titleBlock.enabled, (v) =>
        edit(() => void (sheet.titleBlock.enabled = v)),
      ),
      textField('図面名称', sheet.titleBlock.fields.drawingName, (v) =>
        edit(() => void (sheet.titleBlock.fields.drawingName = v)),
      ),
      textField('図面番号', sheet.titleBlock.fields.drawingNumber, (v) =>
        edit(() => void (sheet.titleBlock.fields.drawingNumber = v)),
      ),
      textField('企業(団体)名', sheet.titleBlock.fields.company, (v) =>
        edit(() => void (sheet.titleBlock.fields.company = v)),
      ),
      textField('責任者', sheet.titleBlock.fields.designer, (v) =>
        edit(() => void (sheet.titleBlock.fields.designer = v)),
      ),
      textField('作成年月日', sheet.titleBlock.fields.date, (v) =>
        edit(() => void (sheet.titleBlock.fields.date = v)),
      ),
    ];
  }
}

import { sceneBounds } from '../../../core/entity.ts';
import { centerSheetOn, fitsInFrame, jisMargins, paperDimensions } from '../../../core/sheet.ts';
import { PAPER_SIZES } from '../../../core/standard.ts';
import { checkboxField, el, readonlyField, selectField, textField } from '../../dom.ts';
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

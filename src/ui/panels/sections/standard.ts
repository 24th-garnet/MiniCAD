import {
  JIS_TEXT_HEIGHTS,
  LINE_GROUPS,
  PLAN_SCALES,
  STANDARD_PRESETS,
  lineGroupById,
} from '../../../core/standard.ts';
import { checkboxField, el, numberField, readonlyField, selectField } from '../../dom.ts';
import type { Section, PanelContext } from '../../panel.ts';

/** 製図規格。図面の属性なので変更は履歴に残す */
export class StandardSection implements Section {
  render(ctx: PanelContext): (HTMLElement | null)[] {
    const scene = ctx.editor.store.scene;
    const std = scene.standard;
    const level = scene.level;
    const edit = ctx.edit;
    const group = lineGroupById(std.lineGroupId);

    return [
      el('h2', {}, ['製図規格']),
      selectField(
        'プリセット',
        '',
        [{ value: '', label: std.preset }, ...STANDARD_PRESETS.map((p) => ({ value: p.id, label: p.label }))],
        (v) => {
          const preset = STANDARD_PRESETS.find((p) => p.id === v);
          if (preset) edit(() => void (scene.standard = preset.make()));
        },
      ),
      selectField(
        '線群 (JIS Z 8312)',
        std.lineGroupId,
        LINE_GROUPS.map((g) => ({ value: g.id, label: g.label })),
        (v) => edit(() => void (std.lineGroupId = v)),
      ),
      selectField(
        '尺度 (JIS Z 8314)',
        String(std.scale),
        PLAN_SCALES.map((n) => ({ value: String(n), label: `1:${n}` })),
        (v) => edit(() => void (std.scale = Number(v))),
      ),
      selectField(
        '室名の文字高',
        String(std.textHeight.room),
        JIS_TEXT_HEIGHTS.map((h) => ({ value: String(h), label: `${h} mm` })),
        (v) => edit(() => void (std.textHeight.room = Number(v))),
      ),
      selectField(
        '寸法の文字高',
        String(std.textHeight.dimension),
        JIS_TEXT_HEIGHTS.map((h) => ({ value: String(h), label: `${h} mm` })),
        (v) => edit(() => void (std.textHeight.dimension = Number(v))),
      ),
      checkboxField('壁を塗りつぶす', std.wallFill, (v) => edit(() => void (std.wallFill = v))),
      readonlyField('細 / 太 / 極太', `${group.thin} / ${group.thick} / ${group.extraThick} mm`),
      // 高さは紙の属性ではなく建物の属性なので Level に持っているが、設定欄はここにまとめる
      numberField('壁の高さ', level.wallHeight, (v: number) => edit(() => void (level.wallHeight = Math.max(1, v))), {
        step: 100,
        min: 1,
        suffix: 'mm',
      }),
    ];
  }
}

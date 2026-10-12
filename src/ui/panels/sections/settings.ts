import { checkboxField, el, numberField } from '../../dom.ts';
import type { Section, PanelContext } from '../../panel.ts';

/** 作図の補助設定。図面の中身ではないので履歴には残さない */
export class SettingsSection implements Section {
  render(ctx: PanelContext): (HTMLElement | null)[] {
    const settings = ctx.editor.store.settings;
    const set = ctx.set;

    return [
      el('h2', {}, ['作図設定']),
      numberField('グリッド間隔', settings.gridSize, (v) => set(() => void (settings.gridSize = Math.max(1, v))), {
        step: 50,
        min: 1,
        suffix: 'mm',
      }),
      numberField(
        '新規の壁厚',
        settings.wallThickness,
        (v) => set(() => void (settings.wallThickness = Math.max(10, v))),
        { step: 10, min: 10, suffix: 'mm' },
      ),
      checkboxField('グリッドにスナップ (G)', settings.snapGrid, (v) => set(() => void (settings.snapGrid = v))),
      checkboxField('端点・交点にスナップ', settings.snapNode, (v) => set(() => void (settings.snapNode = v))),
      checkboxField('壁上にスナップ', settings.snapWall, (v) => set(() => void (settings.snapWall = v))),
      checkboxField('直交・角度スナップ (F8)', settings.ortho, (v) => set(() => void (settings.ortho = v))),
      checkboxField('グリッドを表示', settings.showGrid, (v) => set(() => void (settings.showGrid = v))),
      checkboxField('面積を内法で表示', settings.innerArea, (v) => set(() => void (settings.innerArea = v))),
      checkboxField('DXFをShift-JISで書く (Jw_cad 用)', settings.dxfShiftJis, (v) =>
        set(() => void (settings.dxfShiftJis = v)),
      ),
      checkboxField('DXFの日本語を \\U+ でエスケープ', settings.dxfEscapeUnicode, (v) =>
        set(() => void (settings.dxfEscapeUnicode = v)),
      ),
      checkboxField('DXFの寸法を DIMENSION で出す', settings.dxfTrueDimension, (v) =>
        set(() => void (settings.dxfTrueDimension = v)),
      ),
      checkboxField('拘束の記号を表示', settings.showConstraints, (v) =>
        set(() => void (settings.showConstraints = v)),
      ),
    ];
  }
}

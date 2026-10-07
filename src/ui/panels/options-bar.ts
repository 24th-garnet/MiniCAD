import type { OptionField } from '../../tools/tool.ts';
import { clear, el } from '../dom.ts';
import type { Panel, PanelContext } from '../panel.ts';

/**
 * アクティブなツールが返す記述子をそのまま描く。
 * ここはツールの種類を一切知らない。
 */
export class OptionsBar implements Panel {
  constructor(private readonly host: HTMLElement) {}

  refresh(ctx: PanelContext): void {
    clear(this.host);
    const fields = ctx.editor.tool.options?.(ctx.editor) ?? [];
    for (const field of fields) this.host.append(renderField(field, ctx));
  }
}

function renderField(field: OptionField, ctx: PanelContext): HTMLElement {
  const after = () => {
    ctx.editor.requestRender();
    ctx.refresh();
  };

  switch (field.kind) {
    case 'number': {
      const input = el('input', {
        type: 'number',
        value: String(field.value),
        step: field.step ?? 1,
        min: field.min,
        max: field.max,
      });
      const commit = () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) {
          field.onChange(v);
          after();
        }
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          commit();
          input.blur();
        }
        // グローバルのショートカットに数字を奪われないようにする
        e.stopPropagation();
      });
      return el('label', {}, [field.suffix ? `${field.label} (${field.suffix})` : field.label, input]);
    }

    case 'select': {
      const select = el('select', {});
      for (const o of field.options) {
        const opt = el('option', { value: o.value }, [o.label]);
        if (o.value === field.value) opt.selected = true;
        select.append(opt);
      }
      select.addEventListener('change', () => {
        field.onChange(select.value);
        after();
      });
      return el('label', {}, [field.label, select]);
    }

    case 'text': {
      const input = el('input', { type: 'text', value: field.value, placeholder: field.placeholder });
      // 打つたびに描き直すと入力欄が作り直されてしまうので、再描画はしない
      input.addEventListener('input', () => {
        field.onChange(input.value);
        ctx.editor.requestRender();
      });
      input.addEventListener('keydown', (e) => e.stopPropagation());
      return el('label', {}, [field.label, input]);
    }

    case 'toggle': {
      const input = el('input', { type: 'checkbox', checked: field.value });
      input.addEventListener('change', () => {
        field.onChange(input.checked);
        after();
      });
      return el('label', {}, [input, field.label]);
    }

    case 'chips': {
      const host = el('div', { class: 'option-chips' }, []);
      for (const item of field.items) {
        host.append(
          el('button', { type: 'button', onclick: () => { field.onPick(item); after(); } }, [item]),
        );
      }
      return host;
    }

    case 'note':
      return el('span', { class: 'option-note' }, [field.text]);
  }
}

import { layerWeight, type Layer } from '../../../core/layer.ts';
import { LINE_TYPE_LABELS, type LineType, type WeightRole } from '../../../core/standard.ts';
import { el } from '../../dom.ts';
import type { Section, PanelContext } from '../../panel.ts';

const WEIGHT_ROLES: { value: WeightRole; label: string }[] = [
  { value: 'thin', label: '細線' },
  { value: 'thick', label: '太線' },
  { value: 'extraThick', label: '極太線' },
];

/** 画層。DXF の LAYER テーブルにそのまま対応する */
export class LayersSection implements Section {
  render(ctx: PanelContext): (HTMLElement | null)[] {
    const scene = ctx.editor.store.scene;
    const out: (HTMLElement | null)[] = [el('h2', {}, ['画層 (DXF レイヤ)'])];
    for (const layer of Object.values(scene.layers)) {
      out.push(layerRow(layer, ctx));
    }
    return out;
  }
}

function layerRow(layer: Layer, ctx: PanelContext): HTMLElement {
  const std = ctx.editor.store.scene.standard;
  const edit = ctx.edit;

  // 位置ではなくクラスで指せるようにしておく（行に複数のチェックボックスが並ぶため）
  const visible = el('input', { class: 'layer-visible', type: 'checkbox', checked: layer.visible, title: '表示' });
  visible.addEventListener('change', () => edit(() => void (layer.visible = visible.checked)));

  const locked = el('input', {
    class: 'layer-locked',
    type: 'checkbox',
    checked: layer.locked,
    title: 'ロック（選択できなくする）',
  });
  locked.addEventListener('change', () => edit(() => void (layer.locked = locked.checked)));

  const swatch = el('span', { class: 'swatch', title: `ACI ${layer.aci}` });
  swatch.style.background = layer.color;

  const roleSelect = el('select', { title: '線の太さ' });
  for (const r of WEIGHT_ROLES) {
    const opt = el('option', { value: r.value }, [r.label]);
    if (r.value === layer.weightRole) opt.selected = true;
    roleSelect.append(opt);
  }
  roleSelect.addEventListener('change', () => edit(() => void (layer.weightRole = roleSelect.value as WeightRole)));

  const typeSelect = el('select', { title: '線種' });
  for (const [value, label] of Object.entries(LINE_TYPE_LABELS) as [LineType, string][]) {
    const opt = el('option', { value }, [label]);
    if (value === layer.lineType) opt.selected = true;
    typeSelect.append(opt);
  }
  typeSelect.addEventListener('change', () => edit(() => void (layer.lineType = typeSelect.value as LineType)));

  return el('div', { class: 'layer-row' }, [
    el('div', { class: 'layer-head' }, [
      visible,
      swatch,
      el('span', { class: 'layer-name', title: layer.name }, [layer.name]),
      el('span', { class: 'layer-mm' }, [`${layerWeight(layer, std).toFixed(2)}mm`]),
    ]),
    el('div', { class: 'layer-controls' }, [roleSelect, typeSelect, lockLabel(locked)]),
  ]);
}

function lockLabel(input: HTMLInputElement): HTMLElement {
  return el('label', { class: 'layer-lock', title: 'ロック' }, [input, 'ロック']);
}

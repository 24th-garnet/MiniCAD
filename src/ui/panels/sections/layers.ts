import { removeLayer } from '../../../core/entity.ts';
import {
  ACI_COLORS,
  addLayer,
  isBuiltinLayer,
  layerWeight,
  renameLayer,
  setLayerColor,
  type Layer,
} from '../../../core/layer.ts';
import { LINE_TYPE_LABELS, type LineType, type WeightRole } from '../../../core/standard.ts';
import { el, selectField } from '../../dom.ts';
import type { Section, PanelContext } from '../../panel.ts';

const WEIGHT_ROLES: { value: WeightRole; label: string }[] = [
  { value: 'thin', label: '細線' },
  { value: 'thick', label: '太線' },
  { value: 'extraThick', label: '極太線' },
];

/** 画層。DXF の LAYER テーブルにそのまま対応する */
export class LayersSection implements Section {
  render(ctx: PanelContext): (HTMLElement | null)[] {
    const store = ctx.editor.store;
    const scene = store.scene;
    const layers = Object.values(scene.layers);

    const out: (HTMLElement | null)[] = [
      el('h2', {}, ['画層 (DXF レイヤ)']),
      // 新規作成をどの画層に置くか。null なら種別ごとの既定（壁は A-WALL、文字は A-ANNO-TEXT …）
      selectField(
        '新規作成の画層',
        store.settings.currentLayerId ?? '',
        [{ value: '', label: '種別ごとの既定' }, ...layers.map((l) => ({ value: l.id, label: l.name }))],
        (v) => ctx.set(() => void (store.settings.currentLayerId = v || null)),
      ),
    ];

    for (const layer of layers) out.push(layerRow(layer, ctx));

    out.push(
      el(
        'button',
        {
          class: 'wide',
          type: 'button',
          onclick: () => ctx.edit(() => void addLayer(scene.layers)),
        },
        ['＋ 画層を追加'],
      ),
    );
    return out;
  }
}

function layerRow(layer: Layer, ctx: PanelContext): HTMLElement {
  const scene = ctx.editor.store.scene;
  const edit = ctx.edit;
  const builtin = isBuiltinLayer(layer.id);

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

  const name = el('input', {
    class: 'layer-name',
    type: 'text',
    value: layer.name,
    title: builtin ? `${layer.name}（組み込みの画層）` : layer.name,
  });
  const commitName = () => {
    if (!renameLayer(scene.layers, layer.id, name.value)) {
      // 空名や重複は受け付けない。入力欄を元に戻して知らせる
      name.value = layer.name;
      return;
    }
    edit(() => true);
  };
  name.addEventListener('change', commitName);
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') name.blur();
    e.stopPropagation();
  });

  const roleSelect = compactSelect(
    '線の太さ',
    WEIGHT_ROLES.map((r) => ({ value: r.value, label: r.label })),
    layer.weightRole,
    (v) => edit(() => void (layer.weightRole = v as WeightRole)),
  );

  const typeSelect = compactSelect(
    '線種',
    (Object.entries(LINE_TYPE_LABELS) as [LineType, string][]).map(([value, label]) => ({ value, label })),
    layer.lineType,
    (v) => edit(() => void (layer.lineType = v as LineType)),
  );

  const colorSelect = compactSelect(
    '色 (ACI)',
    ACI_COLORS.map((c) => ({ value: String(c.aci), label: c.label })),
    String(layer.aci),
    (v) => edit(() => setLayerColor(scene.layers, layer.id, Number(v))),
  );

  const controls: HTMLElement[] = [roleSelect, typeSelect, colorSelect];
  if (!builtin) {
    controls.push(
      el(
        'button',
        {
          class: 'layer-delete',
          type: 'button',
          title: 'この画層を削除（中身は既定の画層へ移ります）',
          onclick: () => edit(() => removeLayer(scene, layer.id)),
        },
        ['×'],
      ),
    );
  }

  return el('div', { class: 'layer-row' }, [
    el('div', { class: 'layer-head' }, [
      visible,
      locked,
      swatch,
      name,
      el('span', { class: 'layer-mm' }, [`${layerWeight(layer, scene.standard).toFixed(2)}mm`]),
    ]),
    el('div', { class: 'layer-controls' }, controls),
  ]);
}

function compactSelect(
  title: string,
  options: { value: string; label: string }[],
  value: string,
  onChange: (v: string) => void,
): HTMLSelectElement {
  const select = el('select', { title });
  for (const o of options) {
    const opt = el('option', { value: o.value }, [o.label]);
    if (o.value === value) opt.selected = true;
    select.append(opt);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

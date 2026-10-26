import { activateView, captureView, clampOpacity, viewsInOrder, type DrawingView } from '../../../core/view.ts';
import { newId } from '../../../core/types.ts';
import { el, numberField } from '../../dom.ts';
import type { PanelContext, Section } from '../../panel.ts';

/**
 * 図面ビュー。**画面では利用者の言葉（「レイヤー」）に寄せて「図面」と呼ぶ。**
 *
 * ワイヤーの「レイヤー」（躯体図 / 平面配置 / 天井伏図、各々 1/100、透過つき）は
 * CAD の画層ではなく、画層の見え方と縮尺の組。`core/view.ts` を参照。
 */
export class ViewsSection implements Section {
  render(ctx: PanelContext): (HTMLElement | null)[] {
    const scene = ctx.editor.store.scene;
    const views = viewsInOrder(scene);
    const out: (HTMLElement | null)[] = [el('h2', {}, ['図面'])];

    const list = el('ul', { class: 'view-list' }, []);
    for (const view of views) list.append(row(view, ctx));
    out.push(list);

    out.push(
      el('button', {
        class: 'wide',
        type: 'button',
        title: 'いまの画層の見え方と縮尺を、新しい図面として覚える',
        onclick: () => ctx.edit(() => {
          // **今の状態をそのまま複製する。** 新しい図面を作ってから
          // 画層を全部付け直すのは、ふつう誰もやりたくない
          captureView(scene);
          const id = newId('vw');
          const base = scene.views[scene.activeViewId];
          scene.views[id] = {
            id,
            name: `${base?.name ?? '図面'} の複製`,
            scale: scene.standard.scale,
            layerStates: structuredClone(base?.layerStates ?? {}),
          };
          scene.activeViewId = id;
        }),
      }, ['＋ いまの状態を図面として覚える']),
    );

    out.push(el('p', { class: 'empty-note' }, [
      '図面を切り替えると、画層の表示・透過・縮尺がまとめて入れ替わります。'
      + '透過は画面だけで、SVG にも DXF にも出せません（書き出すときに知らせます）。',
    ]));
    return out;
  }
}

function row(view: DrawingView, ctx: PanelContext): HTMLElement {
  const scene = ctx.editor.store.scene;
  const active = scene.activeViewId === view.id;
  const only = Object.keys(scene.views).length === 1;

  const name = el('input', { class: 'view-name', type: 'text', value: view.name });
  name.addEventListener('change', () => ctx.edit(() => void (view.name = name.value.trim() || view.name)));
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') name.blur();
    e.stopPropagation();
  });

  const pick = el('input', { class: 'view-active', type: 'radio', name: 'minicad-view', checked: active });
  pick.addEventListener('change', () => ctx.edit(() => activateView(scene, view.id)));

  const children: (HTMLElement | null)[] = [
    el('div', { class: 'view-head' }, [
      pick,
      name,
      el('span', { class: 'view-scale' }, [`1:${Math.round(view.scale)}`]),
      only
        ? null
        : el('button', {
            class: 'view-delete',
            type: 'button',
            title: 'この図面を削除（画層そのものは消えません）',
            onclick: () => ctx.edit(() => {
              delete scene.views[view.id];
              if (scene.activeViewId === view.id) {
                const next = Object.keys(scene.views)[0];
                scene.activeViewId = next;
                activateView(scene, next);
              }
            }),
          }, ['×']),
    ]),
  ];

  // 縮尺と透過は作業中の図面だけ触れる。他の図面の見え方は、
  // 切り替えてから直す（当てていないものを直すと、何が効いたか分からない）
  if (active) {
    children.push(
      numberField('縮尺 1:', scene.standard.scale, (v) => ctx.edit(() => {
        const next = Math.max(1, Math.round(v));
        scene.standard.scale = next;
        view.scale = next;
      }), { step: 10, min: 1 }),
      opacityRow(ctx),
    );
  }
  return el('li', { class: active ? 'view-row active' : 'view-row' }, children);
}

/** 作業中の図面の、画層ごとの透過 */
function opacityRow(ctx: PanelContext): HTMLElement {
  const scene = ctx.editor.store.scene;
  const host = el('div', { class: 'view-opacity' }, [el('span', { class: 'attr-head' }, ['透過'])]);
  for (const layer of Object.values(scene.layers)) {
    const slider = el('input', {
      type: 'range', min: 0, max: 100, step: 5,
      value: String(Math.round(layer.opacity * 100)),
      title: `${layer.name} の不透明度`,
    });
    slider.addEventListener('input', () => ctx.edit(() => {
      layer.opacity = clampOpacity(Number(slider.value) / 100);
      captureView(scene);
    }));
    host.append(el('div', { class: 'field' }, [el('span', {}, [layer.name]), slider]));
  }
  return host;
}

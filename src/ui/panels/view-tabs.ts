import type { Viewer3D } from '../../render3d/viewer.ts';
import { clear, el } from '../dom.ts';
import type { Panel, PanelContext } from '../panel.ts';
import { VIEW_LABELS, VIEW_MODES } from '../view-state.ts';
import { ORBIT_CENTER_LABELS, type OrbitCenter } from '../../render3d/camera.ts';

/**
 * 2D / 3D / 分割の切り替え。
 *
 * **どのビューかは `ctx.view` が権威。** `Viewer3D.isVisible()` は
 * 「3D が見えているか」しか答えられず、分割では 2D も同時に見えている。
 *
 * `Viewer3D` 自身は `Panel` にしない。`App.refresh()` が全パネルを毎回呼ぶので、
 * 隠れているときも描画要求が立ってしまう。ここはボタンだけを持つ。
 */
export class ViewTabs implements Panel {
  constructor(
    private readonly host: HTMLElement,
    private readonly viewer: Viewer3D,
  ) {}

  refresh(ctx: PanelContext): void {
    clear(this.host);

    for (const mode of VIEW_MODES) {
      this.host.append(
        el('button', {
          type: 'button',
          'aria-pressed': String(ctx.view.mode === mode),
          onclick: () => {
            ctx.view.set(mode);
          },
        }, [VIEW_LABELS[mode]]),
      );
    }

    // カメラの操作は 3D が見えているときだけ意味がある
    if (!ctx.view.shows3d) return;
    this.host.append(
      el('button', { type: 'button', title: '図面全体が入るように合わせる', onclick: () => this.viewer.fit() }, [
        '全体',
      ]),
      el(
        'button',
        {
          type: 'button',
          'aria-pressed': String(this.viewer.showEdges),
          title: '面の稜線を重ねる',
          onclick: () => {
            this.viewer.showEdges = !this.viewer.showEdges;
            this.viewer.requestRender();
            ctx.refresh();
          },
        },
        ['稜線'],
      ),
      el(
        'button',
        {
          type: 'button',
          'aria-pressed': String(this.viewer.camera.mode === 'ortho'),
          title: '平行投影に切り替える',
          onclick: () => {
            this.viewer.camera.mode = this.viewer.camera.mode === 'ortho' ? 'perspective' : 'ortho';
            this.viewer.requestRender();
            ctx.refresh();
          },
        },
        ['平行'],
      ),
      // **回す中心。** カメラだけの話で、メッシュにもピックにも触らない
      el(
        'select',
        {
          class: 'orbit-center',
          title: 'ドラッグで回すときの中心',
          onchange: (e: Event) => {
            this.viewer.orbitCenter = (e.target as HTMLSelectElement).value as OrbitCenter;
            this.viewer.requestRender();
          },
        },
        (Object.keys(ORBIT_CENTER_LABELS) as OrbitCenter[]).map((k) =>
          el('option', { value: k, selected: this.viewer.orbitCenter === k ? '' : undefined },
            [ORBIT_CENTER_LABELS[k]]),
        ),
      ),
      el(
        'button',
        {
          type: 'button',
          title: '目線の高さに下りて歩き回る視点にする',
          onclick: () => {
            this.viewer.flyOverHere();
            ctx.refresh();
          },
        },
        ['歩く'],
      ),
    );
  }
}

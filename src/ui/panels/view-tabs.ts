import type { Viewer3D } from '../../render3d/viewer.ts';
import { clear, el } from '../dom.ts';
import type { Panel, PanelContext } from '../panel.ts';
import { VIEW_LABELS, VIEW_MODES } from '../view-state.ts';

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
    );
  }
}

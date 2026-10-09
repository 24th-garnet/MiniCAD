import type { Viewer3D } from '../../render3d/viewer.ts';
import { clear, el } from '../dom.ts';
import type { Panel, PanelContext } from '../panel.ts';

/**
 * 2D と 3D の切り替え。
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
    const is3d = this.viewer.isVisible();

    const tab = (label: string, active: boolean, onClick: () => void) =>
      el('button', { type: 'button', 'aria-pressed': String(active), onclick: onClick }, [label]);

    this.host.append(
      tab('2D', !is3d, () => this.show(ctx, false)),
      tab('3D', is3d, () => this.show(ctx, true)),
    );

    if (!is3d) return;
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

  private show(ctx: PanelContext, is3d: boolean): void {
    this.viewer.setVisible(is3d);
    ctx.refresh();
  }
}

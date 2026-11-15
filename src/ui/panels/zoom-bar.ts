import { vec } from '../../core/geometry.ts';
import { clear, el } from '../dom.ts';
import { icon } from '../icon.ts';
import type { Panel, PanelContext } from '../panel.ts';

/** 1 回押したときの倍率。ホイール 1 段より大きく、押し続けなくても動く */
const STEP = 1.25;

/**
 * 図面の倍率。**キャンバスの左下に浮かせる。**
 *
 * 倍率は `Viewport` が前から持っていたのに、**画面から触る口が無かった**
 * ——ホイールか `0`（全体表示）しか無く、ホイールの無い環境では
 * 寄ることもできなかった。ワイヤー（`ベース図面.html`）の `.bottom-bar` は
 * 「1F ／ 👁 ／ − 100% +」の形で、Coohom も同じところに置いている。
 *
 * **出すのは尺度ではなく倍率。** 尺度（1:50）はステータスバーの右端が
 * 出している——あちらは紙に刷ったときの縮尺で、画面の拡大とは別のもの。
 * ここは「いま何倍で見ているか」だけ。
 *
 * **軸は画面の中心。** ホイールはカーソルの位置を軸にするが、ボタンには
 * カーソルの位置が無い。中心にしておけば、押しても見ているものが逃げない。
 */
export class ZoomBar implements Panel {
  constructor(private readonly host: HTMLElement) {}

  refresh(ctx: PanelContext): void {
    clear(this.host);
    const vp = ctx.editor.viewport;
    // 既定の 0.06 を 100% と読む。mm とピクセルの比をそのまま出しても読めない
    const percent = Math.round((vp.scale / 0.06) * 100);

    const step = (label: string, name: 'minus' | 'plus', factor: number) =>
      el(
        'button',
        {
          class: 'zoom-step',
          type: 'button',
          title: label,
          onclick: () => {
            vp.zoomAt(vec(vp.width / 2, vp.height / 2), factor);
            ctx.editor.requestRender();
            ctx.refresh();
          },
        },
        [icon(name, 16)],
      );

    this.host.append(
      step('縮小', 'minus', 1 / STEP),
      // 押すと全体表示。**数字が押せることは `title` で言う**
      el(
        'button',
        {
          class: 'zoom-value',
          type: 'button',
          title: '図面全体が見えるように戻す（0）',
          onclick: () => {
            ctx.editor.zoomToFit();
            ctx.refresh();
          },
        },
        [`${percent}%`],
      ),
      step('拡大', 'plus', STEP),
    );
  }
}

import type { Panel, PanelContext } from './panel.ts';

export class StatusBar implements Panel {
  constructor(
    private readonly hint: HTMLElement,
    private readonly readout: HTMLElement,
  ) {}

  refresh(ctx: PanelContext): void {
    this.hint.textContent = ctx.editor.tool.status(ctx.editor);
    this.refreshReadout(ctx);
  }

  /** 座標表示だけはポインタ移動のたびに更新したいので、単独で呼べるようにしてある */
  refreshReadout(ctx: PanelContext): void {
    const p = ctx.editor.pointerWorld();
    const s = ctx.editor.store.settings;
    const flags = [s.snapGrid ? 'グリッド' : null, s.ortho ? '直交' : null].filter(Boolean).join(' / ');
    const snap = ctx.editor.lastSnap;
    const snapText = snap && snap.kind !== 'free' && snap.label ? `  [${snap.label}]` : '';
    const zoom = Math.round(1 / ctx.editor.viewport.scale);
    this.readout.textContent =
      `X ${Math.round(p.x)}  Y ${Math.round(p.y)} mm   |   1:${zoom}   |   ${flags || 'スナップなし'}${snapText}`;
  }
}

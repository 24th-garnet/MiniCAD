import { activeLevel } from '../core/level.ts';
import type { Viewer3D } from '../render3d/viewer.ts';
import type { Panel, PanelContext } from './panel.ts';

export class StatusBar implements Panel {
  constructor(
    private readonly hint: HTMLElement,
    private readonly readout: HTMLElement,
    private readonly viewer: Viewer3D,
  ) {}

  refresh(ctx: PanelContext): void {
    // 3D だけを出しているあいだは 2D のツールに手が届かない。掴んでいる最中は
    // 分割でも 3D の説明を優先する（壁の高さの数値はそこにしか出ない）
    const use3d = ctx.view.mode === '3d' || (ctx.view.isSplit && this.viewer.isGrabbing());
    this.hint.textContent = use3d ? this.viewer.status() : ctx.editor.tool.status(ctx.editor);
    this.refreshReadout(ctx);
  }

  /** 座標表示だけはポインタ移動のたびに更新したいので、単独で呼べるようにしてある */
  refreshReadout(ctx: PanelContext): void {
    // 3D だけのときに平面の座標を出すと、2D を離れた時点の値が残って嘘になる。
    // **持っていないものは、持っていないと書く**
    if (!ctx.view.shows2d) {
      const scene = ctx.editor.store.scene;
      const projection = this.viewer.camera.mode === 'ortho' ? '平行投影' : '透視投影';
      this.readout.textContent = `${activeLevel(scene).name}   |   ${projection}   |   平面の座標は出ません`;
      return;
    }
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

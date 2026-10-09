import { resolvePoint } from '../core/coord-input.ts';
import { angleOf, dist, mid, toDeg, type Vec } from '../core/geometry.ts';
import { drawSnapMarker, type Frame } from '../render/renderer.ts';
import { fontOf, theme } from '../render/theme.ts';
import type { Editor } from '../ui/editor.ts';
import { pointerAngleFrom } from './wall.ts';
import type { NumericEntry, PointerInfo, Tool } from './tool.ts';

/** 2点間の距離を測るだけのツール。シーンは一切変更しない */
export class MeasureTool implements Tool {
  readonly id = 'measure' as const;
  readonly label = '計測';
  readonly shortcut = 'M';
  readonly cursor = 'crosshair';
  readonly group = 'modify' as const;

  private from: Vec | null = null;
  private to: Vec | null = null;

  onActivate(editor: Editor): void {
    editor.store.clearSelection();
    this.from = null;
    this.to = null;
  }

  onDeactivate(editor: Editor): void {
    this.cancel(editor);
  }

  isActive(): boolean {
    return this.from !== null;
  }

  cancel(editor: Editor): void {
    this.from = null;
    this.to = null;
    editor.snapContext = {};
    editor.requestRender();
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;
    if (this.from && this.to) {
      this.from = null;
      this.to = null;
    }
    if (!this.from) {
      this.from = p.world;
      this.to = null;
      editor.snapContext = { from: this.from };
    } else {
      this.to = p.world;
      editor.snapContext = {};
    }
  }

  onKeyDown(editor: Editor, e: KeyboardEvent): boolean {
    if (e.key === 'Escape' && this.from) {
      this.cancel(editor);
      return true;
    }
    return false;
  }

  numericEntry(_editor: Editor): NumericEntry | null {
    if (!this.from || this.to) return null;
    return {
      mode: 'point',
      base: this.from,
      fallbackAngleDeg: (ed) => pointerAngleFrom(ed, this.from),
      submit: (ed, input) => {
        const point = resolvePoint(input, this.from, pointerAngleFrom(ed, this.from));
        if (!point) return;
        this.to = point;
        ed.snapContext = {};
        ed.requestRender();
      },
    };
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    const snap = editor.lastSnap;
    const a = this.from;
    const b = this.to ?? snap?.point ?? null;
    if (snap && snap.kind !== 'free') drawSnapMarker(frame, snap.point, snap.label);
    if (!a || !b) return;

    const { ctx, vp } = frame;
    const sa = vp.toScreen(a);
    const sb = vp.toScreen(b);
    ctx.save();
    ctx.strokeStyle = theme.snap;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const s of [sa, sb]) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = theme.snap;
      ctx.fill();
    }

    const length = dist(a, b);
    const deg = (toDeg(angleOf({ x: b.x - a.x, y: b.y - a.y })) + 360) % 360;
    const text = `${length.toFixed(0)} mm   ${deg.toFixed(1)}°`;
    const c = vp.toScreen(mid(a, b));
    ctx.font = fontOf(12);
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillRect(c.x - w / 2 - 6, c.y - 24, w + 12, 19);
    ctx.strokeStyle = theme.snap;
    ctx.lineWidth = 1;
    ctx.strokeRect(c.x - w / 2 - 6, c.y - 24, w + 12, 19);
    ctx.fillStyle = theme.dimensionText;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, c.x, c.y - 14.5);
    ctx.restore();
  }

  status(): string {
    if (!this.from) return '始点をクリック';
    if (!this.to) return '終点をクリックで確定 / Esc で取り消し';
    return 'クリックで新しい計測を開始';
  }
}

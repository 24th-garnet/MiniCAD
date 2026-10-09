import { closestOnSegment, dist, type Vec } from '../core/geometry.ts';
import { clampOpening, wallEnds, wallLength } from '../core/ops.ts';
import { LAYER_IDS, resolveNewLayer } from '../core/layer.ts';
import { openingFrame, openingQuad } from '../core/shape.ts';
import { newId, type Id, type Opening, type OpeningKind } from '../core/types.ts';
import { theme } from '../render/theme.ts';
import type { Frame } from '../render/renderer.ts';
import type { Editor } from '../ui/editor.ts';
import type { OptionField, PointerInfo, Tool, ToolId } from './tool.ts';

interface Candidate {
  wallId: Id;
  offset: number;
}

/** ドア・窓を壁に差し込むツール。壁の上にしか置けないので、常に最寄りの壁へ吸着する */
export class OpeningTool implements Tool {
  readonly id: ToolId;
  readonly label: string;
  readonly shortcut: string;
  readonly cursor = 'crosshair';
  readonly group = 'draw' as const;

  private readonly kind: OpeningKind;
  /** 開口幅 (mm)。ツールバーから変更される */
  width: number;
  flipX = false;
  flipY = false;

  private candidate: Candidate | null = null;

  constructor(kind: OpeningKind, id: ToolId, label: string, shortcut: string, width: number) {
    this.kind = kind;
    this.id = id;
    this.label = label;
    this.shortcut = shortcut;
    this.width = width;
  }

  onActivate(editor: Editor): void {
    editor.store.clearSelection();
    this.candidate = null;
  }

  onDeactivate(): void {
    this.candidate = null;
  }

  onPointerMove(editor: Editor, p: PointerInfo): void {
    this.candidate = this.findCandidate(editor, p.raw);
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;
    const candidate = this.candidate ?? this.findCandidate(editor, p.raw);
    if (!candidate) return;
    const store = editor.store;
    const id = newId('o');
    const opening: Opening = {
      id,
      wallId: candidate.wallId,
      offset: candidate.offset,
      width: this.width,
      kind: this.kind,
      flipX: this.flipX,
      flipY: this.flipY,
      layerId: resolveNewLayer(store.scene.layers, store.settings.currentLayerId, LAYER_IDS.opening),
    };
    store.commit(() => {
      store.scene.openings[id] = opening;
    });
  }

  onKeyDown(editor: Editor, e: KeyboardEvent): boolean {
    // 開き勝手の反転。X で吊元、Y で開く向き
    if (e.key === 'x' || e.key === 'X') {
      this.flipX = !this.flipX;
      editor.requestRender();
      return true;
    }
    if (e.key === 'y' || e.key === 'Y') {
      this.flipY = !this.flipY;
      editor.requestRender();
      return true;
    }
    return false;
  }

  /** カーソルに最も近い壁の、開口が収まる位置を探す */
  private findCandidate(editor: Editor, p: Vec): Candidate | null {
    const scene = editor.store.scene;
    const limit = editor.viewport.toWorldLength(40);
    let best: { wallId: Id; offset: number; d: number } | null = null;

    for (const wall of Object.values(scene.walls)) {
      const [a, b] = wallEnds(scene, wall);
      const c = closestOnSegment(p, a, b);
      const reach = Math.max(limit, wall.thickness);
      if (c.dist > reach) continue;
      const raw = c.t * dist(a, b);
      const offset = clampOpening(scene, wall.id, raw, this.width);
      if (offset === null) continue;
      if (!best || c.dist < best.d) best = { wallId: wall.id, offset, d: c.dist };
    }
    return best ? { wallId: best.wallId, offset: best.offset } : null;
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    const candidate = this.candidate;
    if (!candidate) return;
    const scene = editor.store.scene;
    const preview: Opening = {
      id: '__preview',
      wallId: candidate.wallId,
      offset: candidate.offset,
      width: this.width,
      kind: this.kind,
      flipX: this.flipX,
      flipY: this.flipY,
      layerId: LAYER_IDS.opening,
    };
    const f = openingFrame(scene, preview);
    if (!f) return;
    const { ctx, vp } = frame;
    ctx.save();
    ctx.beginPath();
    openingQuad(f).forEach((q, i) => {
      const s = vp.toScreen(q);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(37, 99, 235, 0.35)';
    ctx.fill();
    ctx.strokeStyle = theme.preview;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  options(): OptionField[] {
    return [
      {
        kind: 'number',
        label: '幅 (mm)',
        value: this.width,
        step: 50,
        min: 100,
        onChange: (v) => void (this.width = Math.max(100, v)),
      },
      { kind: 'note', text: 'X で吊元反転 / Y で開き反転' },
    ];
  }

  status(editor: Editor): string {
    if (Object.keys(editor.store.scene.walls).length === 0) return 'まず壁を描いてください';
    if (!this.candidate) return '壁の上にカーソルを合わせてクリック';
    const wall = editor.store.scene.walls[this.candidate.wallId];
    const total = wall ? Math.round(wallLength(editor.store.scene, wall)) : 0;
    return `幅 ${this.width}mm / 壁長 ${total}mm の ${Math.round(this.candidate.offset)}mm の位置  —  X で吊元反転、Y で開き反転`;
  }
}

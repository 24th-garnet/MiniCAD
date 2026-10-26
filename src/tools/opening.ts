import { defaultAttrs } from '../core/attrs.ts';
import { closestOnSegment, dist, type Vec } from '../core/geometry.ts';
import { clampOpening, wallEnds, wallLength } from '../core/ops.ts';
import { LAYER_IDS, resolveNewLayer } from '../core/layer.ts';
import { openingFrame, openingQuad } from '../core/shape.ts';
import { OPENING_SYMBOLS, openingKindsOf, openingPrimitives } from '../core/opening.ts';
import { newId, type Id, type Opening, type OpeningKind } from '../core/types.ts';
import { theme } from '../render/theme.ts';
import { drawPrimitives } from '../render/primitive.ts';
import { getLayer } from '../core/layer.ts';
import type { Frame } from '../render/renderer.ts';
import { BAY_LABELS, BAY_SHAPES, type Bay, type BayShape } from '../core/bay.ts';
import type { Editor } from '../ui/editor.ts';
import type { OptionField, PointerInfo, Tool, ToolId } from './tool.ts';

interface Candidate {
  wallId: Id;
  offset: number;
}

/**
 * ドア・窓を壁に差し込むツール。壁の上にしか置けないので、常に最寄りの壁へ吸着する。
 *
 * 種別はツールではなくオプションのセレクタで選ぶ。JIS A 0150 の建具は 10 種あり、
 * 1 種ごとにツールを立てるとツールバーが破綻するため。
 */
export class OpeningTool implements Tool {
  readonly id: ToolId;
  readonly label: string;
  readonly shortcut: string;
  readonly cursor = 'crosshair';
  readonly group = 'draw' as const;

  private readonly family: 'door' | 'window';
  /** 選択中の種別。オプションのセレクタで切り替える */
  kind: OpeningKind;
  /** 開口幅 (mm)。種別を変えると既定値に追従する */
  width: number;
  flipX = false;
  flipY = false;

  private candidate: Candidate | null = null;

  constructor(family: 'door' | 'window', id: ToolId, label: string, shortcut: string) {
    this.family = family;
    this.id = id;
    this.label = label;
    this.shortcut = shortcut;
    this.kind = openingKindsOf(family)[0];
    this.width = OPENING_SYMBOLS[this.kind].defaultWidth;
  }

  private get symbol() {
    return OPENING_SYMBOLS[this.kind];
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
      sillHeight: null,
      bay: this.bay ? { ...this.bay } : null,
      height: null,
      layerId: resolveNewLayer(store.scene.layers, store.settings.currentLayerId, LAYER_IDS.opening),
      attrs: defaultAttrs(),
    };
    store.commit(() => {
      store.scene.openings[id] = opening;
    });
  }

  onKeyDown(editor: Editor, e: KeyboardEvent): boolean {
    // 反転。X で吊元・引き勝手、Y で開く向き。
    // その種別で意味を持たないときは握りつぶさず、他のショートカットへ通す
    if ((e.key === 'x' || e.key === 'X') && this.symbol.usesFlipX) {
      this.flipX = !this.flipX;
      editor.requestRender();
      return true;
    }
    if ((e.key === 'y' || e.key === 'Y') && this.symbol.usesFlipY) {
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
      sillHeight: null,
      bay: this.bay ? { ...this.bay } : null,
      height: null,
      layerId: LAYER_IDS.opening,
      attrs: defaultAttrs(),
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

    // 置く前に記号そのものを見せる。開き勝手や引き勝手は置いてから直すより選ぶほうが速い
    const layer = getLayer(scene.layers, LAYER_IDS.opening, LAYER_IDS.opening);
    drawPrimitives(frame, openingPrimitives(scene, preview), layer, theme.preview);
  }

  /** 出窓・ニッチを付けて置く。パレットの「出窓」が立てる */
  bay: Bay | null = null;

  options(): OptionField[] {
    const flips = [
      this.symbol.usesFlipX ? 'X で吊元・引き勝手' : null,
      this.symbol.usesFlipY ? 'Y で開く向き' : null,
    ].filter(Boolean);
    const fields: OptionField[] = [
      {
        kind: 'select',
        label: '種類',
        value: this.kind,
        options: openingKindsOf(this.family).map((k) => ({ value: k, label: OPENING_SYMBOLS[k].label })),
        onChange: (v: string) => {
          this.kind = v as OpeningKind;
          this.width = this.symbol.defaultWidth;
        },
      },
      {
        kind: 'number',
        label: '幅 (mm)',
        value: this.width,
        step: 50,
        min: 100,
        onChange: (v: number) => void (this.width = Math.max(100, v)),
      },
    ];
    if (this.bay) {
      fields.push(
        {
          kind: 'select',
          label: '張り出し',
          value: this.bay.shape,
          options: BAY_SHAPES.map((k) => ({ value: k, label: BAY_LABELS[k] })),
          onChange: (v: string) => void (this.bay = { ...this.bay!, shape: v as BayShape }),
        },
        {
          kind: 'number',
          label: '出 (mm)',
          value: this.bay.depth,
          step: 50,
          onChange: (v: number) => void (this.bay = { ...this.bay!, depth: v }),
        },
      );
    }
    if (flips.length > 0) fields.push({ kind: 'note', text: `${flips.join(' / ')}を反転` });
    return fields;
  }

  status(editor: Editor): string {
    if (Object.keys(editor.store.scene.walls).length === 0) return 'まず壁を描いてください';
    if (!this.candidate) return '壁の上にカーソルを合わせてクリック';
    const wall = editor.store.scene.walls[this.candidate.wallId];
    const total = wall ? Math.round(wallLength(editor.store.scene, wall)) : 0;
    const hint = this.symbol.usesFlipX || this.symbol.usesFlipY ? '  —  X / Y で反転' : '';
    return `${this.symbol.label} 幅 ${this.width}mm / 壁長 ${total}mm の ${Math.round(this.candidate.offset)}mm の位置${hint}`;
  }
}

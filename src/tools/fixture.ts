import { defaultAttrs } from '../core/attrs.ts';
import {
  FIXTURE_KINDS,
  FIXTURE_SPECS,
  fixturePrimitives,
  outline,
  type Fixture,
  type FixtureKind,
} from '../core/fixture.ts';
import type { Vec } from '../core/geometry.ts';
import { LAYER_IDS, resolveNewLayer } from '../core/layer.ts';
import { levelOf } from '../core/level.ts';
import { newId } from '../core/types.ts';
import { drawPrimitives } from '../render/primitive.ts';
import { tracePolygon } from '../render/frame.ts';
import { type Frame } from '../render/renderer.ts';
import type { Editor } from '../ui/editor.ts';
import type { OptionField, PointerInfo, Tool } from './tool.ts';

/**
 * 構造物を置くツール。柱・梁・階段・スロープ・吹抜を 1 つのツールで扱う。
 *
 * **種別ごとにツールを作らない。** 置き方はどれも同じ（向きを決めて 1 点を打つ）で、
 * 違うのは既定の大きさと記号だけ。それは `FIXTURE_SPECS` の 1 行に閉じている。
 * ツールを 6 つに割ると `ToolId` と `TOOL_REGISTRY` が 6 行ずつ増え、
 * ツールバーが構造だけで埋まる。建具が `door` と `window` の 2 つなのは、
 * **JIS の平面記号が違う**からで、こちらにはその理由が無い。
 */
export class FixtureTool implements Tool {
  readonly id = 'fixture' as const;
  readonly label = '構造';
  readonly shortcut = 'K';
  readonly cursor = 'crosshair';
  readonly group = 'draw' as const;

  /** 置こうとしている種別。パレットから変わる */
  kind: FixtureKind = 'column';
  /** 手動の回転角 */
  angle = 0;
  private ghost: Fixture | null = null;

  /**
   * 種別ごとに直した大きさ。**`FIXTURE_SPECS` は書き換えない。**
   * あれはモジュール共有の表で、書き換えると読み込み時の既定値まで動く。
   */
  private readonly sizes = new Map<FixtureKind, { w: number; h: number }>();

  private sizeOf(kind: FixtureKind): { w: number; h: number } {
    return this.sizes.get(kind) ?? { ...FIXTURE_SPECS[kind].defaultSize };
  }

  /** 円柱は直径 1 つで決まるので、幅を直したら奥行も揃える */
  private setSize(kind: FixtureKind, w: number | null, h: number | null): void {
    const size = this.sizeOf(kind);
    if (w !== null) size.w = w;
    if (h !== null) size.h = h;
    if (kind === 'roundColumn') size.h = size.w;
    this.sizes.set(kind, size);
  }

  onActivate(editor: Editor): void {
    editor.store.clearSelection();
    this.ghost = this.makeGhost(editor, editor.pointerWorld());
  }

  onDeactivate(): void {
    this.ghost = null;
  }

  onPointerMove(editor: Editor, p: PointerInfo): void {
    this.ghost = this.makeGhost(editor, p.world);
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;
    const ghost = this.makeGhost(editor, p.world);
    if (!ghost) return;
    const store = editor.store;
    store.commit(() => {
      store.scene.fixtures[ghost.id] = ghost;
    });
    this.ghost = this.makeGhost(editor, p.world);
  }

  onKeyDown(editor: Editor, e: KeyboardEvent): boolean {
    if (e.key === 'r' || e.key === 'R') {
      this.angle += (Math.PI / 2) * (e.shiftKey ? -1 : 1);
      this.ghost = this.makeGhost(editor, editor.pointerWorld());
      editor.requestRender();
      return true;
    }
    return false;
  }

  private makeGhost(editor: Editor, p: Vec): Fixture {
    const scene = editor.store.scene;
    const spec = FIXTURE_SPECS[this.kind];
    return {
      id: newId('f'),
      kind: this.kind,
      x: p.x,
      y: p.y,
      angle: this.angle,
      size: this.sizeOf(this.kind),
      // 既定のままにしておけば、階高を変えたときに柱と梁が自分で追従する
      base: null,
      height: null,
      label: spec.defaultLabel,
      layerId: resolveNewLayer(scene.layers, editor.store.settings.currentLayerId, spec.defaultLayer),
      levelId: scene.activeLevelId,
      attrs: defaultAttrs(),
    };
  }

  options(editor: Editor): OptionField[] {
    const spec = FIXTURE_SPECS[this.kind];
    const size = this.sizeOf(this.kind);
    const level = levelOf(editor.store.scene, editor.store.scene.activeLevelId);
    const fields: OptionField[] = [
      {
        kind: 'select',
        label: '種類',
        value: this.kind,
        options: FIXTURE_KINDS.map((k) => ({ value: k, label: FIXTURE_SPECS[k].label })),
        onChange: (v) => {
          this.kind = v as FixtureKind;
          this.ghost = this.makeGhost(editor, editor.pointerWorld());
        },
      },
      {
        kind: 'number',
        label: this.kind === 'roundColumn' ? '直径' : '幅',
        value: size.w,
        step: 50,
        min: 10,
        suffix: 'mm',
        onChange: (v) => this.setSize(this.kind, Math.max(10, v), null),
      },
    ];
    if (this.kind !== 'roundColumn') {
      fields.push({
        kind: 'number',
        label: '奥行',
        value: size.h,
        step: 50,
        min: 10,
        suffix: 'mm',
        onChange: (v) => this.setSize(this.kind, null, Math.max(10, v)),
      });
    }
    fields.push({
      kind: 'note',
      text: `高さ ${Math.round(spec.defaultHeight(level))}mm（下端 ${Math.round(spec.defaultBase(level))}mm）/ R で90°回転`,
    });
    return fields;
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    const ghost = this.ghost;
    if (!ghost) return;
    const { ctx } = frame;

    ctx.save();
    tracePolygon(frame, outline(ghost));
    ctx.fillStyle = 'rgba(37, 99, 235, 0.16)';
    ctx.fill();
    ctx.restore();

    const layer = editor.store.scene.layers[ghost.layerId] ?? editor.store.scene.layers[LAYER_IDS.wall];
    drawPrimitives(
      frame,
      fixturePrimitives(ghost, editor.store.scene.standard.textHeight.furniture),
      layer,
      'rgba(37, 99, 235, 0.9)',
    );
  }

  status(): string {
    const spec = FIXTURE_SPECS[this.kind];
    const size = this.sizeOf(this.kind);
    const text = this.kind === 'roundColumn' ? `φ${size.w}` : `${size.w}×${size.h}`;
    return `${spec.label} (${text}) — クリックで配置、R で90°回転`;
  }
}

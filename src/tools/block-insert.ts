import { add, angleOf, closestOnSegment, dist, dot, mul, norm, perp, sub, vec, type Vec } from '../core/geometry.ts';
import { blockOf, instanceSize, instanceVertices, type BlockInstance } from '../core/block.ts';
import { LAYER_IDS, getLayer, resolveNewLayer } from '../core/layer.ts';
import { instancePrimitives } from '../core/block.ts';
import { wallEnds } from '../core/ops.ts';
import { newId } from '../core/types.ts';
import { drawPrimitives } from '../render/primitive.ts';
import { type Frame } from '../render/renderer.ts';
import { tracePolygon } from '../render/frame.ts';
import { theme } from '../render/theme.ts';
import type { Editor } from '../ui/editor.ts';
import type { OptionField, PointerInfo, Tool } from './tool.ts';

/** この距離より壁に近ければ、ブロックを壁に沿わせる (mm) */
const WALL_ALIGN_RANGE = 900;

/**
 * ブロックを置くツール。
 * 以前の家具ツールを、中身をブロック定義に移したうえで引き継いでいる。
 * 壁沿わせは家具固有の便利機能だったが、ブロック全般に効かせて困らない。
 */
export class BlockInsertTool implements Tool {
  readonly id = 'block' as const;
  readonly label = 'ブロック';
  readonly shortcut = 'B';
  readonly cursor = 'crosshair';
  readonly group = 'draw' as const;

  /** 選んでいるブロック定義 */
  blockId = 'bed-single';
  /** 手動の回転角。壁沿わせが効いているときは壁の向きに加算される */
  angle = 0;
  private ghost: BlockInstance | null = null;

  onActivate(editor: Editor): void {
    editor.store.clearSelection();
    this.ensureBlock(editor);
    this.ghost = this.makeGhost(editor, editor.pointerWorld(), false);
  }

  onDeactivate(): void {
    this.ghost = null;
  }

  /** 画層や定義が消えていたときに、置けるものへ寄せる */
  private ensureBlock(editor: Editor): void {
    const blocks = editor.store.scene.blocks;
    if (!blocks[this.blockId]) this.blockId = Object.keys(blocks)[0] ?? '';
  }

  onPointerMove(editor: Editor, p: PointerInfo): void {
    // Alt を押している間は壁沿わせを無効化する
    this.ghost = this.makeGhost(editor, p.raw, p.alt);
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;
    const ghost = this.makeGhost(editor, p.raw, p.alt);
    if (!ghost) return;
    const store = editor.store;
    store.commit(() => {
      store.scene.instances[ghost.id] = ghost;
    });
    this.ghost = this.makeGhost(editor, p.raw, p.alt);
  }

  onKeyDown(editor: Editor, e: KeyboardEvent): boolean {
    if (e.key === 'r' || e.key === 'R') {
      this.angle += (Math.PI / 2) * (e.shiftKey ? -1 : 1);
      this.ghost = this.makeGhost(editor, editor.pointerWorld(), false);
      editor.requestRender();
      return true;
    }
    return false;
  }

  private makeGhost(editor: Editor, p: Vec, skipWallAlign: boolean): BlockInstance | null {
    const scene = editor.store.scene;
    this.ensureBlock(editor);
    const def = scene.blocks[this.blockId];
    if (!def) return null;

    const base: BlockInstance = {
      id: newId('i'),
      blockId: this.blockId,
      layerId: resolveNewLayer(scene.layers, editor.store.settings.currentLayerId, LAYER_IDS.furniture),
      x: p.x,
      y: p.y,
      scaleX: 1,
      scaleY: 1,
      angle: this.angle,
      label: null,
      levelId: scene.activeLevelId,
    };
    if (skipWallAlign) return this.snapToGrid(editor, base);
    return alignToNearestWall(editor, base, def.size, this.angle) ?? this.snapToGrid(editor, base);
  }

  private snapToGrid(editor: Editor, inst: BlockInstance): BlockInstance {
    const { snapGrid, gridSize } = editor.store.settings;
    if (!snapGrid || gridSize <= 0) return inst;
    return { ...inst, x: Math.round(inst.x / gridSize) * gridSize, y: Math.round(inst.y / gridSize) * gridSize };
  }

  options(editor: Editor): OptionField[] {
    const blocks = Object.values(editor.store.scene.blocks);
    return [
      {
        kind: 'select',
        label: 'ブロック',
        value: this.blockId,
        options: blocks.map((b) => ({ value: b.id, label: `${b.label}  ${b.size.w}×${b.size.h}` })),
        onChange: (v) => void (this.blockId = v),
      },
      { kind: 'note', text: 'R で90°回転 / Alt で壁沿わせ解除' },
    ];
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    const ghost = this.ghost;
    if (!ghost) return;
    const scene = editor.store.scene;
    const { ctx } = frame;

    ctx.save();
    tracePolygon(frame, instanceVertices(scene, ghost));
    ctx.fillStyle = 'rgba(37, 99, 235, 0.16)';
    ctx.fill();
    ctx.restore();

    const layer = getLayer(scene.layers, ghost.layerId, LAYER_IDS.furniture);
    drawPrimitives(frame, instancePrimitives(scene, ghost, scene.standard), layer, theme.preview);
  }

  status(editor: Editor): string {
    const def = editor.store.scene.blocks[this.blockId];
    if (!def) return 'ブロックがありません';
    return `${def.label} (${def.size.w}×${def.size.h}) — クリックで配置、R で90°回転、Alt で壁沿わせ解除`;
  }
}

/**
 * 近くの壁に背を付ける。
 * 壁の向きに合わせて回転し、壁面からブロックの奥行の半分だけ室内側へ押し出す。
 */
function alignToNearestWall(
  editor: Editor,
  inst: BlockInstance,
  size: { w: number; h: number },
  extraAngle: number,
): BlockInstance | null {
  const scene = editor.store.scene;
  let best: { point: Vec; dir: Vec; thickness: number; d: number } | null = null;

  for (const wall of Object.values(scene.walls)) {
    const [a, b] = wallEnds(scene, wall);
    if (dist(a, b) < 1) continue;
    const c = closestOnSegment(vec(inst.x, inst.y), a, b);
    if (c.dist > WALL_ALIGN_RANGE) continue;
    if (!best || c.dist < best.d) {
      best = { point: c.point, dir: norm(sub(b, a)), thickness: wall.thickness, d: c.dist };
    }
  }
  if (!best) return null;

  const n = perp(best.dir);
  // カーソルが壁のどちら側にいるかで押し出す向きを決める
  const side = dot(sub(vec(inst.x, inst.y), best.point), n) >= 0 ? 1 : -1;
  const angle = angleOf(best.dir) + extraAngle;

  // 回転後の奥行（壁に垂直な方向の寸法）だけ室内側へ出す
  const depth = Math.abs(Math.sin(extraAngle)) * size.w + Math.abs(Math.cos(extraAngle)) * size.h;
  const center = add(best.point, mul(n, side * (best.thickness / 2 + depth / 2)));
  return { ...inst, x: center.x, y: center.y, angle };
}

export { blockOf, instanceSize };

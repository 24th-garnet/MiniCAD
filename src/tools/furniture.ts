import { add, angleOf, closestOnSegment, dist, dot, mul, norm, perp, sub, vec, type Vec } from '../core/geometry.ts';
import { wallEnds } from '../core/ops.ts';
import { LAYER_IDS } from '../core/layer.ts';
import { FURNITURE_PRESETS, furniturePolygon, type FurniturePreset } from '../core/shape.ts';
import { newId, type Furniture } from '../core/types.ts';
import type { Frame } from '../render/renderer.ts';
import { theme } from '../render/theme.ts';
import type { Editor } from '../ui/editor.ts';
import type { PointerInfo, Tool } from './tool.ts';

/** この距離より壁に近ければ、家具を壁に沿わせる (mm) */
const WALL_ALIGN_RANGE = 900;

export class FurnitureTool implements Tool {
  readonly id = 'furniture' as const;
  readonly label = '家具';
  readonly shortcut = 'F';
  readonly cursor = 'crosshair';

  preset: FurniturePreset = FURNITURE_PRESETS[0];
  /** 手動の回転角。壁沿わせが効いているときは壁の向きに加算される */
  angle = 0;
  private ghost: Furniture | null = null;

  onActivate(editor: Editor): void {
    editor.store.clearSelection();
    this.ghost = this.makeGhost(editor, editor.pointerWorld(), false);
  }

  onDeactivate(): void {
    this.ghost = null;
  }

  onPointerMove(editor: Editor, p: PointerInfo): void {
    // Alt を押している間は壁沿わせを無効化する
    this.ghost = this.makeGhost(editor, p.raw, p.alt);
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;
    const ghost = this.makeGhost(editor, p.raw, p.alt);
    const store = editor.store;
    store.commit(() => {
      store.scene.furniture[ghost.id] = ghost;
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

  private makeGhost(editor: Editor, p: Vec, skipWallAlign: boolean): Furniture {
    const base: Furniture = {
      id: newId('f'),
      kind: this.preset.kind,
      name: this.preset.name,
      x: p.x,
      y: p.y,
      w: this.preset.w,
      h: this.preset.h,
      angle: this.angle,
      layerId: LAYER_IDS.furniture,
    };
    if (skipWallAlign) return this.snapToGrid(editor, base);

    const aligned = alignToNearestWall(editor, base, this.angle);
    return aligned ?? this.snapToGrid(editor, base);
  }

  private snapToGrid(editor: Editor, f: Furniture): Furniture {
    const { snapGrid, gridSize } = editor.store.settings;
    if (!snapGrid || gridSize <= 0) return f;
    return { ...f, x: Math.round(f.x / gridSize) * gridSize, y: Math.round(f.y / gridSize) * gridSize };
  }

  drawOverlay(_editor: Editor, frame: Frame): void {
    const ghost = this.ghost;
    if (!ghost) return;
    const { ctx, vp } = frame;
    ctx.save();
    ctx.beginPath();
    furniturePolygon(ghost).forEach((q, i) => {
      const s = vp.toScreen(q);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(37, 99, 235, 0.16)';
    ctx.fill();
    ctx.strokeStyle = theme.preview;
    ctx.setLineDash([5, 3]);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  status(): string {
    return `${this.preset.name} (${this.preset.w}×${this.preset.h}) — クリックで配置、R で90°回転、Alt で壁沿わせ解除`;
  }
}

/**
 * 近くの壁に家具の背を付ける。
 * 壁の向きに合わせて回転し、壁面から家具の奥行の半分だけ室内側へ押し出す。
 */
function alignToNearestWall(editor: Editor, f: Furniture, extraAngle: number): Furniture | null {
  const scene = editor.store.scene;
  let best: { point: Vec; dir: Vec; thickness: number; d: number } | null = null;

  for (const wall of Object.values(scene.walls)) {
    const [a, b] = wallEnds(scene, wall);
    if (dist(a, b) < 1) continue;
    const c = closestOnSegment(vec(f.x, f.y), a, b);
    if (c.dist > WALL_ALIGN_RANGE) continue;
    if (!best || c.dist < best.d) {
      best = { point: c.point, dir: norm(sub(b, a)), thickness: wall.thickness, d: c.dist };
    }
  }
  if (!best) return null;

  const n = perp(best.dir);
  // カーソルが壁のどちら側にいるかで押し出す向きを決める
  const side = dot(sub(vec(f.x, f.y), best.point), n) >= 0 ? 1 : -1;
  const wallAngle = angleOf(best.dir);
  const angle = wallAngle + extraAngle;

  // 回転後の奥行（壁に垂直な方向の寸法）だけ室内側へ出す
  const depth = Math.abs(Math.sin(extraAngle)) * f.w + Math.abs(Math.cos(extraAngle)) * f.h;
  const offset = best.thickness / 2 + depth / 2;
  const center = add(best.point, mul(n, side * offset));

  // 壁に沿った位置はカーソルの投影位置をそのまま使う
  return { ...f, x: center.x, y: center.y, angle };
}

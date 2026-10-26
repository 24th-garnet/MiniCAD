import { stampAssembly, type Assembly } from '../core/assembly.ts';
import type { Vec } from '../core/geometry.ts';
import { type Frame } from '../render/renderer.ts';
import type { Editor } from '../ui/editor.ts';
import type { OptionField, PointerInfo, Tool } from './tool.ts';

/**
 * シンボルを置く。
 *
 * **置いた瞬間に実体に展開される。** 壁もノードも建具も本物として置かれるので、
 * 部屋検出は無改造で効き、DXF もそのまま出る。由来は `Attrs.symbolId` に残る。
 */
export class AssemblyTool implements Tool {
  readonly id = 'assembly' as const;
  readonly label = 'シンボル';
  readonly shortcut = 'I';
  readonly cursor = 'crosshair';
  readonly group = 'draw' as const;

  /** 置こうとしているシンボル。パレットから変わる */
  assemblyId: string | null = null;
  angle = 0;

  onActivate(editor: Editor): void {
    editor.store.clearSelection();
    this.ensure(editor);
  }

  private ensure(editor: Editor): Assembly | null {
    const list = Object.values(editor.store.scene.assemblies);
    if (list.length === 0) return null;
    const got = this.assemblyId ? editor.store.scene.assemblies[this.assemblyId] : null;
    if (got) return got;
    this.assemblyId = list[0].id;
    return list[0];
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;
    const assembly = this.ensure(editor);
    if (!assembly) return;
    const store = editor.store;
    let placed: ReturnType<typeof stampAssembly> = [];
    store.commit(() => {
      placed = stampAssembly(store.scene, assembly, p.world, this.angle, store.scene.activeLevelId);
      return placed.length > 0;
    });
    if (placed.length > 0) store.setSelection(placed);
  }

  onKeyDown(editor: Editor, e: KeyboardEvent): boolean {
    if (e.key === 'r' || e.key === 'R') {
      this.angle += (Math.PI / 2) * (e.shiftKey ? -1 : 1);
      editor.requestRender();
      return true;
    }
    return false;
  }

  options(editor: Editor): OptionField[] {
    const list = Object.values(editor.store.scene.assemblies);
    if (list.length === 0) {
      return [{ kind: 'note', text: 'シンボルがありません。選択してプロパティから作れます' }];
    }
    return [
      {
        kind: 'select',
        label: 'シンボル',
        value: this.assemblyId ?? list[0].id,
        options: list.map((a) => ({ value: a.id, label: `${a.name}（v${a.version}）` })),
        onChange: (v) => void (this.assemblyId = v),
      },
      { kind: 'note', text: 'R で90°回転 / 置くと実体に展開されます' },
    ];
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    const assembly = this.assemblyId ? editor.store.scene.assemblies[this.assemblyId] : null;
    if (!assembly) return;
    const at = editor.pointerWorld();
    const { ctx } = frame;

    // **中身の壁の芯線だけを出す。** 置く前に向きと大きさが分かればよく、
    // 本物そっくりに描くと、置いたのか置いていないのか分からなくなる
    ctx.save();
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    for (const w of Object.values(assembly.body.walls)) {
      const a = assembly.body.nodes[w.a];
      const b = assembly.body.nodes[w.b];
      if (!a || !b) continue;
      const pa = frame.vp.toScreen(place(a, at, this.angle));
      const pb = frame.vp.toScreen(place(b, at, this.angle));
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const f of Object.values(assembly.body.fixtures)) {
      const s = frame.vp.toScreen(place(f, at, this.angle));
      ctx.beginPath();
      ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  status(editor: Editor): string {
    const assembly = this.assemblyId ? editor.store.scene.assemblies[this.assemblyId] : null;
    if (!assembly) return 'シンボルがありません。選択してプロパティから作れます';
    const n = Object.keys(assembly.body.walls).length;
    return `${assembly.name}（壁 ${n} 本）— クリックで配置、R で90°回転`;
  }
}

function place(p: { x: number; y: number }, at: Vec, angle: number): Vec {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: at.x + p.x * c - p.y * s, y: at.y + p.x * s + p.y * c };
}

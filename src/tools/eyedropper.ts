import { attrsOf } from '../core/material.ts';
import { isSelectable } from '../core/entity.ts';
import { applyEyedrop, pickEyedrop, type Eyedrop } from '../core/eyedrop.ts';
import { getLayer } from '../core/layer.ts';
import type { EntityRef, Scene } from '../core/types.ts';
import type { Vec } from '../core/geometry.ts';
import { instanceVertices } from '../core/block.ts';
import { strokeSegments } from '../render/frame.ts';
import { theme } from '../render/theme.ts';
import { shapeOutline } from '../core/shapes.ts';
import { wallEnds } from '../core/ops.ts';
import { outline as fixtureOutline } from '../core/fixture.ts';
import { type Frame } from '../render/renderer.ts';
import type { Editor } from '../ui/editor.ts';
import type { OptionField, PointerInfo, Tool } from './tool.ts';

/**
 * スポイト（ワイヤー 7 枚目の「色調整／カラーピッカー／スポイト」）。
 *
 * **クリックで吸い、Alt+クリックで配る。** 画像編集で定着している操作で、
 * モードの切り替えが要らない。選んであるものにまとめて配る道もオプションに出す。
 *
 * **運ぶのは 4 つだけ**——色・素材・積算区分と、画層。
 *
 * | 運ばないもの | 理由 |
 * |---|---|
 * | `groupId` | 配ると、人の作ったグループに勝手に加わる |
 * | `stampId` / `symbolId` / `symbolVersion` | 配ると、**シンボルの一括変更が押し直す相手を壊す** |
 *
 * 吸った画層は「これから描く画層」（`settings.currentLayerId`）にも入れる。
 * スポイトで揃えたあと、続けて同じ画層に描けるほうが手に馴染む。
 *
 * **キーを持たない。** A〜Z が全部埋まっていて、空きが 1 つも無い。
 */
export class EyedropperTool implements Tool {
  readonly id = 'eyedrop' as const;
  readonly label = 'スポイト';
  readonly shortcut = '';
  readonly cursor = 'crosshair';
  readonly group = 'modify' as const;

  /** 吸ってある中身。まだ何も吸っていなければ null */
  private held: Eyedrop | null = null;

  onActivate(editor: Editor): void {
    editor.store.clearSelection();
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;
    const ref = this.pick(editor, p.raw);
    if (!ref) return;
    if (p.alt) this.apply(editor, [ref]);
    else this.suck(editor, ref);
  }

  /** 吸う。**シーンは変えない**ので履歴にも残さない */
  private suck(editor: Editor, ref: EntityRef): void {
    const held = pickEyedrop(editor.store.scene, ref);
    if (!held) return;
    this.held = held;
    // 続けて同じ画層に描けるようにする
    editor.store.update(() => void (editor.store.settings.currentLayerId = held.layerId));
    editor.notifyUi();
  }

  /** 配る。**画層と 3 つの属性だけ**を上書きする */
  private apply(editor: Editor, refs: EntityRef[]): void {
    const held = this.held;
    if (!held || refs.length === 0) return;
    editor.store.commit(() => applyEyedrop(editor.store.scene, refs, held));
    editor.requestRender();
  }

  /** 属性を持つものだけを拾う。ノードと室名ラベルは持っていない */
  private pick(editor: Editor, at: { x: number; y: number }): EntityRef | null {
    const ref = editor.pick(at, editor.pickRadius());
    if (!ref || !isSelectable(editor.store.scene, ref)) return null;
    return attrsOf(editor.store.scene, ref) ? ref : null;
  }

  options(editor: Editor): OptionField[] {
    const held = this.held;
    if (!held) {
      return [{ kind: 'note', text: 'クリックで吸う / Alt+クリックで配る（色・素材・積算・画層）' }];
    }
    const scene = editor.store.scene;
    const layer = getLayer(scene.layers, held.layerId, held.layerId);
    const selection = editor.store.selection.filter((r) => attrsOf(scene, r));
    return [
      { kind: 'note', text: `吸ってあるもの: 色 ${held.color ?? '画層のまま'} / 素材 ${held.materialRef ?? 'なし'} / 積算 ${held.takeoff ?? 'なし'} / 画層 ${layer.name}` },
      { kind: 'note', text: 'Alt+クリックで 1 つずつ配れます' },
      ...(selection.length > 0
        ? [{
            kind: 'chips' as const,
            items: [`選んである ${selection.length} 個に配る`],
            onPick: () => this.apply(editor, selection),
          }]
        : []),
      {
        kind: 'chips',
        items: ['吸ったものを忘れる'],
        onPick: () => {
          this.held = null;
        },
      },
    ];
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    // カーソルの下の実体をなぞって、何を吸う（配る）のかを見せる
    const ref = this.pick(editor, editor.pointerWorld());
    if (!ref) return;
    const segments = outlineOfRef(editor.store.scene, ref);
    if (segments.length === 0) return;
    const { ctx } = frame;
    ctx.save();
    ctx.strokeStyle = this.held ? theme.preview : 'rgba(37, 99, 235, 0.45)';
    ctx.lineWidth = 3;
    strokeSegments(frame, segments);
    ctx.restore();
  }

  status(editor: Editor): string {
    const ref = this.pick(editor, editor.pointerWorld());
    if (!this.held) {
      return ref ? 'クリックで色・素材・積算・画層を吸います' : '吸いたいものにカーソルを合わせてください';
    }
    return ref ? 'Alt+クリックで配ります（クリックで吸い直し）' : '配りたいものにカーソルを合わせて Alt+クリック';
  }
}

/**
 * なぞる輪郭。**当たり判定と同じ折れ線近似**で、`CornerTool` と同じ考え方。
 * 属性を持つ 6 種別のうち、形が引けるものだけを返す。
 */
function outlineOfRef(scene: Scene, ref: EntityRef): { a: Vec; b: Vec }[] {
  const ring = (points: Vec[]): { a: Vec; b: Vec }[] =>
    points.map((p, i) => ({ a: p, b: points[(i + 1) % points.length] }));
  switch (ref.type) {
    case 'shape': {
      const shape = scene.shapes[ref.id];
      return shape ? shapeOutline(scene, shape) : [];
    }
    case 'wall': {
      const wall = scene.walls[ref.id];
      if (!wall) return [];
      const [a, b] = wallEnds(scene, wall);
      return [{ a, b }];
    }
    case 'fixture': {
      const f = scene.fixtures[ref.id];
      return f ? ring(fixtureOutline(f)) : [];
    }
    case 'blockInstance': {
      const inst = scene.instances[ref.id];
      return inst ? ring(instanceVertices(scene, inst)) : [];
    }
    default:
      // 建具と計測は形が 1 本の線で表しにくい。なぞらないだけで、吸えはする
      return [];
  }
}

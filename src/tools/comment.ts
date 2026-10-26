import { point3, type CommentAnchor } from '../core/annotation.ts';
import { newId } from '../core/types.ts';
import { COMMENT_BADGE_R, type Frame } from '../render/renderer.ts';
import { theme } from '../render/theme.ts';
import type { Editor } from '../ui/editor.ts';
import type { PointerInfo, Tool } from './tool.ts';

/**
 * コメントを置く。
 *
 * **MiniCAD は点を置いてホストに知らせるだけ。** 本文・作成者・日時・
 * リプライ・メンション・解決状態・メール通知はすべてホストの仕事で、
 * ここはポップアップも開かない。開くのはホスト。
 *
 * 既にあるバッジを叩いたら、そのコメントを開くようホストに知らせる。
 * **シーンは一切変更しない。** コメントは図面の一部ではないので、
 * 図面を保存しても付いてこないし、undo の対象にもならない。
 */
export class CommentTool implements Tool {
  readonly id = 'comment' as const;
  readonly label = 'コメント';
  readonly shortcut = 'J';
  readonly cursor = 'crosshair';
  readonly group = 'annotate' as const;

  /** ホストへの通知。`App` が差し込む */
  onPlace: ((anchor: CommentAnchor) => void) | null = null;
  onOpen: ((id: string) => void) | null = null;

  onActivate(editor: Editor): void {
    editor.store.clearSelection();
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;

    const hit = pickComment(editor, p.screen);
    if (hit) {
      this.onOpen?.(hit.id);
      return;
    }
    const anchor: CommentAnchor = {
      id: newId('cm'),
      at: point3(p.world.x, p.world.y, 0),
      // 下に何かあれば紐づける。無ければ空間の点
      ref: editor.pick(p.raw),
      levelId: editor.store.scene.activeLevelId,
      badge: null,
    };
    // **先に画面へ出す。** ホストが返事をくれるまで何も出ないと、
    // 叩いたのに何も起きていないように見える
    editor.comments = [...editor.comments, anchor];
    editor.requestRender();
    this.onPlace?.(anchor);
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    // 置ける場所を示すだけ。バッジ自体は renderer が描く
    const p = frame.vp.toScreen(editor.pointerWorld());
    const { ctx } = frame;
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, COMMENT_BADGE_R, 0, Math.PI * 2);
    ctx.strokeStyle = theme.commentBadge;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.restore();
  }

  status(editor: Editor): string {
    const n = editor.comments.length;
    return `クリックでコメントを置く / バッジをクリックで開く（${n} 件）`;
  }
}

/** 画面の点に当たるバッジ。**画面座標で測る**ので、ズームに依らず掴める */
export function pickComment(editor: Editor, screen: { x: number; y: number }): CommentAnchor | null {
  // 後から置いたものが上に来るので逆順に見る
  for (let i = editor.comments.length - 1; i >= 0; i--) {
    const c = editor.comments[i];
    const p = editor.viewport.toScreen({ x: c.at.x, y: c.at.y });
    if (Math.hypot(p.x - screen.x, p.y - screen.y) <= COMMENT_BADGE_R) return c;
  }
  return null;
}

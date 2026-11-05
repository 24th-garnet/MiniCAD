import { point3, type CommentAnchor } from "../core/annotation.ts";
import { levelOf } from "../core/level.ts";
import { newId } from "../core/types.ts";
import type { Editor } from "../ui/editor.ts";
import { aimOnPlane, pointMarker, sameAim, type Aim3D } from "./aim3d.ts";
import type { Face3, FaceSource } from "./mesh.ts";
import type { Pointer3D, Tool3D } from "./interact.ts";

/**
 * 3D の中でコメントを置く（ワイヤー 5 枚目）。
 *
 * > コメントボタン押下／コメントしたい**ポイントをタップ**／ポップアップでコメント
 * > 座標　デフォルト タップした xyz
 *
 * **MiniCAD は点を置いてホストに知らせるだけ。** 本文・作成者・日時・
 * リプライ・メンション・解決状態・メール通知はすべてホストの仕事で、
 * ここはポップアップも開かない（2D の `CommentTool` とまったく同じ約束）。
 *
 * **シーンは一切変更しない。** コメントは図面の一部ではないので、図面を
 * 保存しても付いてこないし、undo の対象にもならない。
 *
 * 既にあるバッジを叩いて開くほうは**前から動いている**——`Viewer3D` が
 * 道具より先にバッジを拾う（図面の上に重ねた印なので、下の面より手前）。
 * 足りなかったのは**置くほう**だけ。
 */
export class Comment3D implements Tool3D {
  /** ホストへの通知。`App` が差し込む（2D の `CommentTool` と同じ形） */
  onPlace: ((anchor: CommentAnchor) => void) | null = null;

  /** いま指している作図面と、その上の点 */
  private aim: Aim3D | null = null;

  isActive(): boolean {
    // **ドラッグ状態を持たない。** 1 クリックで置くので、Esc で取り消すものが無い
    return false;
  }

  cancel(): boolean {
    this.aim = null;
    return false;
  }

  onPointerDown(editor: Editor, p: Pointer3D): void {
    if (p.button !== 0) return;
    this.aimAt(editor, p);
    const aim = this.aim;
    if (!aim) return;

    const scene = editor.store.scene;
    const floor = levelOf(scene, scene.activeLevelId).floorZ;
    const anchor: CommentAnchor = {
      id: newId("cm"),
      // **z は階の床からの高さ。** 描くときに `level.floorZ` を足し直す
      at: point3(aim.at.x, aim.at.y, aim.at.z - floor),
      // 下に何かあれば紐づける。無ければ空間の点
      ref: p.hit?.ref ?? null,
      levelId: scene.activeLevelId,
      badge: null,
    };
    // **先に画面へ出す。** ホストが返事をくれるまで何も出ないと、
    // 叩いたのに何も起きていないように見える
    editor.comments = [...editor.comments, anchor];
    editor.requestRender();
    this.onPlace?.(anchor);
  }

  onPointerMove(editor: Editor, p: Pointer3D): void {
    this.aimAt(editor, p);
  }

  onPointerUp(): void {}

  onPointerLeave(): void {
    this.aim = null;
  }

  private aimAt(editor: Editor, p: Pointer3D): void {
    const next = aimOnPlane(editor, p);
    if (next === null) {
      this.aim = null;
      return;
    }
    if (!sameAim(this.aim, next)) {
      this.aim = next;
      editor.notifyUi();
    }
  }

  /** 置ける場所の印。バッジ自体は `Viewer3D` が `paint` の後に重ねる */
  overlay(editor: Editor): Face3[] {
    if (!this.aim) return [];
    const src: FaceSource = {
      ref: null,
      levelId: editor.store.scene.activeLevelId,
    };
    return pointMarker(this.aim, MARKER_MM, COMMENT_COLOR, src);
  }

  status(editor: Editor): string {
    const n = editor.comments.length;
    if (!this.aim) {
      return `面にカーソルを合わせてクリックでコメントを置く / バッジをクリックで開く（${n} 件）`;
    }
    return (
      `${this.aim.plane.label}の上に置く（高さ ${Math.round(this.aim.at.z)}mm）` +
      ` / バッジをクリックで開く（${n} 件）`
    );
  }
}

/** 印の腕の長さ (mm) */
const MARKER_MM = 150;

const COMMENT_COLOR = "rgba(217, 119, 6, 0.85)";

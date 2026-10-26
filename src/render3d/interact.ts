import { isSelectable } from '../core/entity.ts';
import { sameRef, type EntityRef } from '../core/types.ts';
import type { Editor } from '../ui/editor.ts';
import { pickRay, type Ray3, type RayHit } from './ray.ts';
import type { Face3 } from './mesh.ts';

/**
 * 3D 側のポインタ操作。
 *
 * **`Tool` は実装しない。** `Tool` の契約は 2D でできていて、
 * `drawOverlay` は `Viewport` を持つ `Frame` を取り、`numericEntry` は 2D の
 * `base: Vec` を返し、`options()` は 2D キャンバスの上に出るオプションバーに
 * 並ぶ。半分しか満たせない実装を入れると `Tool` の意味が薄まる。
 *
 * `PointerInfo` に任意の 3D 欄を足す案も採らない。全ツールが
 * 「`world` と `snap` は意味を持たない」を防御的に扱う羽目になり、
 * `WallTool` が 3D のクリックから平然と作図を始める。
 * **黙って誤るより、はっきり届かないほうがよい。**
 *
 * ツールの登録機構も増やさない。3D の相互作用はこの 1 つで足りるので、
 * `ToolId` の union も `TOOL_GLYPH` の表もツールバーのボタンも増えない。
 */

/** 3D のポインタ。`Tool` の `PointerInfo` に相当する */
export interface Pointer3D {
  /** キャンバス内の CSS ピクセル */
  screen: { x: number; y: number };
  ray: Ray3;
  /** いちばん手前に当たった面。何にも当たらなければ null */
  hit: RayHit | null;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  button: number;
}

/**
 * 3D で選ぶ。
 *
 * **2D と同じ `EntityRef` を返す**ので、インスペクタも `resolveSelection` も
 * `ENTITY_KINDS` も無改造で効く。「何も変えなくてよかった」が成果物。
 */
export class Select3D {
  onPointerDown(editor: Editor, p: Pointer3D): void {
    if (p.button !== 0) return;
    const ref = p.hit?.ref ?? null;

    if (!ref) {
      // 床（部屋は派生データで実体がない）や空を叩いたら選択を解く。
      // 2D で何もないところをクリックしたときと同じ
      editor.store.clearSelection();
      return;
    }
    if (p.shift) editor.store.toggleSelection(ref);
    else editor.store.setSelection([ref]);
  }

  onPointerMove(editor: Editor, p: Pointer3D): void {
    const next = p.hit?.ref ?? null;
    if (sameRef(next, editor.hover) || (next === null && editor.hover === null)) return;
    editor.hover = next;
    editor.notifyUi();
  }

  /** ポインタがキャンバスから出たら、ホバーを戻す */
  onPointerLeave(editor: Editor): void {
    if (editor.hover === null) return;
    editor.hover = null;
    editor.notifyUi();
  }

  status(editor: Editor): string {
    const n = editor.store.selection.length;
    if (n === 0) return 'クリックで選択 / ドラッグで回転 / Shift+ドラッグで移動 / ホイールで拡大縮小';
    return `${n} 個を選択中`;
  }
}

/** 選べるものだけを拾う。ロックした画層のものは奥へ素通りする */
export function pickEntity(editor: Editor, ray: Ray3, mesh: Face3[], near: number): RayHit | null {
  const scene = editor.store.scene;
  return pickRay(ray, mesh, near, (ref) => ref !== null && isSelectable(scene, ref));
}

/**
 * 面の色の差し替え。選択中とホバー中を目立たせる。
 *
 * **色の文字列を返すだけ**なので、`paint` が `ctx` に頼むことは変わらない
 * （多角形の fill と stroke だけ）。テストの Canvas スタブはオラクルのまま。
 */
export function highlightOf(editor: Editor): (ref: EntityRef | null) => string | null {
  const selected = new Set(editor.store.selection.map((r) => `${r.type}:${r.id}`));
  const hover = editor.hover;
  return (ref) => {
    if (!ref) return null;
    if (selected.has(`${ref.type}:${ref.id}`)) return SELECTED;
    if (sameRef(ref, hover)) return HOVER;
    return null;
  };
}

const SELECTED = '#2563eb';
const HOVER = '#93b4f5';

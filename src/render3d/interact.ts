import { isSelectable } from '../core/entity.ts';
import { levelOf, wallHeightOf } from '../core/level.ts';
import { attrsOf } from '../core/material.ts';
import { vec, type Vec } from '../core/geometry.ts';
import { mergeNodesAt } from '../core/ops.ts';
import {
  captureOrigins,
  isEmptySelection,
  placeSelection,
  resolveSelection,
  type MoveOrigins,
  type ResolvedSelection,
} from '../core/selection.ts';
import { solveScene } from '../core/constraintSolver.ts';
import { sameRef, type EntityRef, type Id, type Scene } from '../core/types.ts';
import type { Editor } from '../ui/editor.ts';
import { pickRay, rayPlane, rayVerticalAt, type Plane3, type Ray3, type RayHit } from './ray.ts';
import { vec3, type Vec3 } from './mat4.ts';
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

type Drag3D =
  | { kind: 'none' }
  | { kind: 'pending'; ref: EntityRef; grab: Vec3; screen: { x: number; y: number } }
  | {
      kind: 'move';
      before: Scene;
      sel: ResolvedSelection;
      origins: MoveOrigins;
      /** 掴んだ点。これがカーソルの下に留まる */
      grab: Vec3;
      /** 動かす面。掴んだ点を通る */
      plane: Plane3;
      /** 直近に当てた変位。擦れ角で交点が取れないときはこれを保つ */
      delta: Vec;
      moved: boolean;
    }
  | {
      kind: 'height';
      before: Scene;
      wallId: Id;
      /** 掴んだときの高さ (mm) */
      startHeight: number;
      /** 掴んだ点の z */
      grabZ: number;
      /** 上下に動かす軸の足元 */
      axisAt: Vec3;
      moved: boolean;
    };

/** これ以内の動きはクリック扱い */
const DRAG_SLOP = 4;

/** 壁の高さの下限 (mm)。インスペクタの `Math.max(1, v)` と揃える */
const MIN_WALL_HEIGHT = 1;


/** 壁の天端か。法線が真上を向いた壁の面 */
export const isWallTop = (hit: RayHit): boolean =>
  hit.face.ref?.type === 'wall' && hit.face.normal.z > 0.9;

/**
 * 3D で選び、動かす。
 *
 * **2D と同じ `EntityRef` を返し、同じ出口（`placeSelection` → `commitFrom`）を
 * 通る。** インスペクタも `resolveSelection` も `ENTITY_KINDS` も undo も
 * 無改造で効く。新しい書き込みの経路は増えない。
 */
export class Select3D {
  private drag: Drag3D = { kind: 'none' };

  isActive(): boolean {
    return this.drag.kind === 'move' || this.drag.kind === 'height';
  }

  onPointerDown(editor: Editor, p: Pointer3D): void {
    if (p.button !== 0) return;
    const ref = p.hit?.ref ?? null;

    if (!ref) {
      // 床（部屋は派生データで実体がない）や空を叩いたら選択を解く。
      // 2D で何もないところをクリックしたときと同じ
      editor.store.clearSelection();
      this.drag = { kind: 'none' };
      return;
    }
    if (p.shift) editor.store.toggleSelection(ref);
    else if (!editor.store.isSelected(ref)) editor.store.setSelection([ref]);

    const hit = p.hit!;
    // **壁の天端を掴んだら高さを変える。** 側面を掴めば移動。
    // 天端は法線が真上を向いた壁の面で、見えている通りに掴める
    if (ref.type === 'wall' && isWallTop(hit)) {
      const wall = editor.store.scene.walls[ref.id];
      const level = levelOf(editor.store.scene, wall.levelId);
      this.drag = {
        kind: 'height',
        before: structuredClone(editor.store.scene),
        wallId: ref.id,
        startHeight: wallHeightOf(wall, level),
        grabZ: hit.point.z,
        axisAt: vec3(hit.point.x, hit.point.y, level.floorZ),
        moved: false,
      };
      return;
    }

    this.drag = { kind: 'pending', ref, grab: hit.point, screen: p.screen };
  }

  onPointerMove(editor: Editor, p: Pointer3D): void {
    const drag = this.drag;

    if (drag.kind === 'pending') {
      if (Math.hypot(p.screen.x - drag.screen.x, p.screen.y - drag.screen.y) <= DRAG_SLOP) return;
      const sel = resolveSelection(editor.store.scene, editor.store.selection);
      if (isEmptySelection(sel)) {
        this.drag = { kind: 'none' };
        return;
      }
      this.drag = {
        kind: 'move',
        before: structuredClone(editor.store.scene),
        sel,
        origins: captureOrigins(editor.store.scene, sel),
        grab: drag.grab,
        plane: dragPlane(editor, drag.ref, drag.grab),
        delta: vec(0, 0),
        moved: false,
      };
      this.applyMove(editor, p);
      return;
    }

    if (drag.kind === 'move') {
      this.applyMove(editor, p);
      return;
    }

    if (drag.kind === 'height') {
      this.applyHeight(editor, p);
      return;
    }

    const next = p.hit?.ref ?? null;
    if (sameRef(next, editor.hover) || (next === null && editor.hover === null)) return;
    editor.hover = next;
    editor.notifyUi();
  }

  onPointerUp(editor: Editor): void {
    const drag = this.drag;
    this.drag = { kind: 'none' };
    if (drag.kind === 'height') {
      if (drag.moved) editor.store.commitFrom(drag.before);
      return;
    }
    if (drag.kind !== 'move' || !drag.moved) return;
    if (drag.sel.nodeIds.length > 0) mergeNodesAt(editor.store.scene, drag.sel.nodeIds);
    // **2D と同じ出口。** 新しい書き込みの経路は増えない
    editor.store.commitFrom(drag.before);
  }

  /** 途中でやめる。シーンを掴む前に戻す */
  cancel(editor: Editor): boolean {
    const drag = this.drag;
    this.drag = { kind: 'none' };
    if (drag.kind !== 'move' && drag.kind !== 'height') return false;
    editor.store.scene = drag.before;
    editor.notifyChanged();
    return true;
  }

  /**
   * 掴んだ点をカーソルの下に留めたまま動かす。
   *
   * 変位は**面との交点の差**で出す。画面のピクセル差から作ると、
   * カメラの距離と角度で効きが変わって「重い／滑る」になる。
   */
  private applyMove(editor: Editor, p: Pointer3D): void {
    const drag = this.drag;
    if (drag.kind !== 'move') return;

    const at = rayPlane(p.ray, drag.plane);
    // 擦れ角（視線が面と平行に近い）では交点が飛ぶ。直前の変位を保つ
    let delta = at ? vec(at.x - drag.grab.x, at.y - drag.grab.y) : drag.delta;

    const settings = editor.store.settings;
    if (at && settings.snapGrid && settings.gridSize > 0) {
      const g = settings.gridSize;
      delta = vec(Math.round(delta.x / g) * g, Math.round(delta.y / g) * g);
    }

    placeSelection(editor.store.scene, drag.origins, delta);
    // 掴んでいるノードを固定して解く。2D のドラッグと同じ
    solveScene(editor.store.scene, { pinned: new Set(drag.sel.nodeIds) });
    drag.delta = delta;
    drag.moved = true;
    editor.notifyChanged();
  }

  /**
   * 壁の高さを上下に動かす。
   *
   * **このフェーズで唯一「2D では出来ない編集」。** 書くのは `wall.height` だけで、
   * ノードもノードの位置も動かさない。平面図は何も変わらず、立面図と 3D だけが変わる。
   */
  private applyHeight(editor: Editor, p: Pointer3D): void {
    const drag = this.drag;
    if (drag.kind !== 'height') return;
    const wall = editor.store.scene.walls[drag.wallId];
    if (!wall) return;

    const z = rayVerticalAt(p.ray, drag.axisAt, p.ray.origin);
    // 真上から見下ろすと鉛直線が点に潰れて解が無い。直前の高さを保つ
    if (z === null) return;

    let next = drag.startHeight + (z - drag.grabZ);
    const settings = editor.store.settings;
    if (settings.snapGrid && settings.gridSize > 0) {
      next = Math.round(next / settings.gridSize) * settings.gridSize;
    }
    // インスペクタの下限と揃える
    wall.height = Math.max(MIN_WALL_HEIGHT, next);
    drag.moved = true;
    editor.notifyChanged();
  }

  /** ポインタがキャンバスから出たら、ホバーを戻す */
  onPointerLeave(editor: Editor): void {
    if (editor.hover === null) return;
    editor.hover = null;
    editor.notifyUi();
  }

  status(editor: Editor): string {
    if (this.drag.kind === 'height') {
      const h = editor.store.scene.walls[this.drag.wallId]?.height;
      return `壁の高さ ${h === null || h === undefined ? '—' : Math.round(h)}mm / Esc で取り消し`;
    }
    if (this.drag.kind === 'move') return 'ドラッグで移動 / Esc で取り消し';
    const n = editor.store.selection.length;
    if (n === 0) return 'クリックで選択 / ドラッグで回転 / Shift+ドラッグで平行移動 / ホイールで拡大縮小';
    return `${n} 個を選択中（掴んで動かせます）`;
  }
}

/**
 * 何の上で動かすか。
 *
 * **掴んだ点を通る水平面**を使う。`floorZ` の面にすると、机の天板を掴んだのに
 * 床の高さで動くので、カーソルの下から物が逃げる。
 *
 * 建具だけは別で、その壁の鉛直面に沿わせる。水平面だと壁から浮いてしまう
 * （`placeSelection` が壁方向へ射影して `clampOpening` まで掛けるので、
 * 結果は壁の上に乗るが、途中の見え方が嘘になる）。
 */
function dragPlane(editor: Editor, ref: EntityRef, grab: Vec3): Plane3 {
  if (ref.type === 'opening') {
    const scene = editor.store.scene;
    const wall = scene.walls[scene.openings[ref.id]?.wallId ?? ''];
    const a = wall && scene.nodes[wall.a];
    const b = wall && scene.nodes[wall.b];
    if (a && b) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-6) {
        // 壁に沿った鉛直面。法線は壁に直交する水平方向
        return { origin: grab, normal: vec3(-dy / len, dx / len, 0) };
      }
    }
  }
  return { origin: grab, normal: vec3(0, 0, 1) };
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
export function highlightOf(
  editor: Editor,
  materials?: ReadonlyMap<string, string>,
): (ref: EntityRef | null) => string | null {
  const selected = new Set(editor.store.selection.map((r) => `${r.type}:${r.id}`));
  const hover = editor.hover;
  const scene = editor.store.scene;
  return (ref) => {
    if (!ref) return null;
    // **選択とホバーが素材より強い。** いま触っているものが分からなくなる方が困る
    if (selected.has(`${ref.type}:${ref.id}`)) return SELECTED;
    if (sameRef(ref, hover)) return HOVER;
    if (!materials) return null;
    // 色の上書きが素材より強い。作図者が直に指した色なので
    const attrs = attrsOf(scene, ref);
    if (attrs?.color) return attrs.color;
    const key = attrs?.materialRef;
    return key ? (materials.get(key) ?? null) : null;
  };
}

const SELECTED = '#2563eb';
const HOVER = '#93b4f5';

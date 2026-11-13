import { isOnVisibleLayer } from '../core/entity.ts';
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
import { sameRef, type EntityRef, type Scene } from '../core/types.ts';
import type { Editor } from '../ui/editor.ts';
import { pickRay, rayOnAxis, rayPlane, type Plane3, type Ray3, type RayHit } from './ray.ts';
import {
  applyPush,
  pushAxis,
  pushRefusal,
  pushTargetOf,
  type PushTarget,
} from '../core/push.ts';
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

/**
 * 3D の道具。**`Tool`（2D の契約）とは別の、ずっと小さい口。**
 *
 * `Tool` は `drawOverlay(editor, frame)` に 2D の `Viewport` を、
 * `numericEntry` に 2D の点を要求するので、3D 側は半分しか満たせない。
 * **半端に実装して `Tool` の意味を薄めるより、必要な 8 つだけの union を持つ。**
 * ツールバーにも `ToolId` にも出ない——3D の道具は 3D のビュータブから選ぶ。
 *
 * `overlay` が `Tool.drawOverlay` にあたる。`ctx` に直に描かず**面を返す**ので、
 * `paint` の契約（多角形の fill と stroke だけ）がそのまま守られ、
 * 仮の姿も本物と同じ深さ順に並ぶ。
 */
export interface Tool3D {
  onPointerDown(editor: Editor, p: Pointer3D): void;
  onPointerMove(editor: Editor, p: Pointer3D): void;
  onPointerUp(editor: Editor): void;
  onPointerLeave(editor: Editor): void;
  /** 掴んでいる最中か。Esc を取るかの判断に使う */
  isActive(): boolean;
  /** 途中でやめる。戻したら true */
  cancel(editor: Editor): boolean;
  /** 面に重ねて描くもの。作図面の格子や仮の立体 */
  overlay(editor: Editor): Face3[];
  status(editor: Editor): string;
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
      kind: 'push';
      before: Scene;
      target: PushTarget;
      /** 掴んだ点。押し引きの軸はここを通る */
      at: Vec3;
      /** 掴んだ点の、軸の上での位置。変位はここからの差 */
      grab: number;
      moved: boolean;
    };

/** これ以内の動きはクリック扱い */
const DRAG_SLOP = 4;

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
export class Select3D implements Tool3D {
  private drag: Drag3D = { kind: 'none' };

  /** 選ぶだけなので、重ねて描くものは無い */
  overlay(): Face3[] {
    return [];
  }

  isActive(): boolean {
    return this.drag.kind === 'move' || this.drag.kind === 'push';
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
    // **Alt で押し引き。** 修飾なしのドラッグは今まで通り移動で、
    // 壁の天端だけは前から修飾なしで高さが変わる（その手触りを壊さない）
    const wantPush = p.alt || (ref.type === 'wall' && isWallTop(hit));
    // **断った理由は掴み直すまで出したまま。** 消すのはここ 1 か所
    this.refused = null;
    const push = wantPush
      ? pushTargetOf(editor.store.scene, ref, hit.face.normal, hit.point)
      : null;
    if (wantPush && !push) {
      // **黙って移動に落とさない。** 押せると思って Alt を押しているので、
      // 何も起きなければ壊れたように見える
      this.refused = pushRefusal(editor.store.scene, ref, hit.face.normal, hit.point);
      // **言わないと出ない。** 既に選ばれているものを掴み直したときは
      // `setSelection` が走らないので、ここで知らせないと status が古いまま
      if (this.refused) editor.notifyUi();
    }
    if (push) {
      const axis = pushAxis(push);
      const grab = rayOnAxis(p.ray, hit.point, vec3(axis.x, axis.y, axis.z), p.ray.origin);
      if (grab !== null) {
        this.drag = {
          kind: 'push',
          before: structuredClone(editor.store.scene),
          target: push,
          at: hit.point,
          grab,
          moved: false,
        };
        return;
      }
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

    if (drag.kind === 'push') {
      this.applyPush(editor, p);
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
    if (drag.kind === 'push') {
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
    if (drag.kind !== 'move' && drag.kind !== 'push') return false;
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
   * 掴んだ面を、その法線の向きに押し引きする（プッシュ/プル）。
   *
   * **2D では出来ない編集。** 書くのは高さ・下端・大きさの数値だけで、
   * ノードも輪郭も動かさない。壁の天端を掴んで高さを変える操作の一般化で、
   * 何が動くかは `core/push.ts` が決める。
   */
  private applyPush(editor: Editor, p: Pointer3D): void {
    const drag = this.drag;
    if (drag.kind !== 'push') return;

    const axis = pushAxis(drag.target);
    const now = rayOnAxis(p.ray, drag.at, vec3(axis.x, axis.y, axis.z), p.ray.origin);
    // 軸を真正面から見ていると解が無い。直前の値を保つ
    if (now === null) return;

    let d = now - drag.grab;
    const settings = editor.store.settings;
    if (settings.snapGrid && settings.gridSize > 0) {
      d = Math.round(d / settings.gridSize) * settings.gridSize;
    }
    if (!applyPush(editor.store.scene, drag.target, d)) return;
    drag.moved = true;
    editor.notifyChanged();
  }

  /** ポインタがキャンバスから出たら、ホバーを戻す */
  onPointerLeave(editor: Editor): void {
    if (editor.hover === null) return;
    editor.hover = null;
    editor.notifyUi();
  }

  /** 直前に押し引きを断った理由。掴み直すまで status に出す */
  private refused: string | null = null;

  status(editor: Editor): string {
    if (this.drag.kind === 'push') {
      const t = this.drag.target;
      return `${t.label} ${Math.round(sizeOf(editor.store.scene, t))}mm / Esc で取り消し`;
    }
    if (this.drag.kind === 'move') return 'ドラッグで移動 / Esc で取り消し';
    if (this.refused) return this.refused;
    const n = editor.store.selection.length;
    if (n === 0) return 'クリックで選択 / ドラッグで回転 / Shift+ドラッグで平行移動 / ホイールで拡大縮小';
    return `${n} 個を選択中（掴んで移動 / Alt+ドラッグで面を押し引き）`;
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

/** 押し引き中の数値。画面の下に出す */
function sizeOf(scene: Scene, t: PushTarget): number {
  if (t.ref.type === 'wall') return scene.walls[t.ref.id]?.height ?? t.start.height;
  const f = scene.fixtures[t.ref.id];
  if (!f) return 0;
  if (t.what === 'bottom') return f.base ?? t.start.base;
  if (t.what === 'side') return t.axis === 'x' ? f.size.w : f.size.h;
  return f.height ?? t.start.height;
}

/** 選べるものだけを拾う。ロックした画層のものは奥へ素通りする */
export function pickEntity(editor: Editor, ray: Ray3, mesh: Face3[], near: number): RayHit | null {
  const scene = editor.store.scene;
  return pickRay(ray, mesh, near, (ref) => ref !== null && isOnVisibleLayer(scene, ref));
}

/**
 * 歩く先の床。**床でなければ null。**
 *
 * `pickEntity` は `ref !== null` で絞っているので、**床は最初から外れている**
 * ——床の面は部屋から導かれる派生で、実体を持たない（`mesh.ts` の `flatFace`）。
 * 歩く先は床そのものなので、ここは別に用意する。
 *
 * **手前にあるものを全部拾ってから床かどうかを見る。** 壁の向こうの床を
 * 拾えてしまうと、壁をすり抜けて移動できることになる。壁が手前なら壁が返り、
 * 床でないので断られる——それが正しい。
 */
export function pickFloor(editor: Editor, ray: Ray3, mesh: Face3[], near: number): RayHit | null {
  const scene = editor.store.scene;
  const hit = pickRay(ray, mesh, near, (ref) => ref === null || isOnVisibleLayer(scene, ref));
  return hit && hit.face.bucket === 'floor' ? hit : null;
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

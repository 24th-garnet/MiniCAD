import { defaultAttrs } from "../core/attrs.ts";
import {
  FIXTURE_SPECS,
  fixtureKindsOf,
  isRoundFixture,
  tiltTo,
  type Fixture,
  type FixtureKind,
} from "../core/fixture.ts";
import { resolveNewLayer } from "../core/layer.ts";
import { levelOf } from "../core/level.ts";
import { newId, type Scene } from "../core/types.ts";
import type { Editor } from "../ui/editor.ts";
import { buildFixtureFaces } from "./fixture3d.ts";
import type { Face3 } from "./mesh.ts";
import type { Vec3 } from "./mat4.ts";
import type { Pointer3D, Tool3D } from "./interact.ts";
import { planeGridFaces, type WorkPlane } from "./workplane.ts";
import { aimOnPlane, sameAim, type Aim3D } from "./aim3d.ts";

/**
 * 3D の中にソリッドを置く。**3D で「新しく描く」最初の 1 つ。**
 *
 * これまで 3D は「既にあるものを選んで動かす」だけで、`interact.ts` は
 * 「黙って誤るより、はっきり届かないほうがよい」として `Tool` を実装していなかった。
 * `Tool`（2D の契約）は今も実装しない——`drawOverlay` は `Viewport` を取り、
 * `numericEntry` は 2D の点を返す。代わりに `Select3D` と同じ形の小さな union
 * （`Tool3D`）に並べる。
 *
 * **作図面は人が選ばない。いま指している面がそのまま作図面になる**
 * （何にも当たっていなければその階の床）。格子はその面の上に敷く。
 *
 * **作図面が立体の向きも決める。** 指した面の法線にローカルの +z を合わせるので、
 * 斜面を指せば斜面に沿って、壁を指せば壁から生えて置かれる。ワイヤーの注記
 * 「斜面を作業面として設定すると、立方体を配置するときに回転する必要がなくなる」
 * がこれ。床（上を向いた面）では傾きが付かず、これまでと同じ置き方になる。
 */
export class Place3D implements Tool3D {
  /** 置く種別。汎用ソリッドだけ */
  kind: FixtureKind = fixtureKindsOf("solid")[0];
  /**
   * z 軸まわりの向き。**傾きはこれを含めて解く**ので、
   * 向きを変えても底面は作図面に乗ったまま（`tiltTo` を見よ）
   */
  angle = 0;

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
    const fixture = this.make(editor, aim.at, aim.plane);
    editor.store.commit(() => {
      editor.store.scene.fixtures[fixture.id] = fixture;
      return true;
    });
    editor.store.setSelection([{ type: "fixture", id: fixture.id }]);
  }

  onPointerMove(editor: Editor, p: Pointer3D): void {
    this.aimAt(editor, p);
  }

  onPointerUp(): void {}

  onPointerLeave(): void {
    this.aim = null;
  }

  /** いま指している面と、その上の（格子に丸めた）点 */
  private aimAt(editor: Editor, p: Pointer3D): void {
    const next = aimOnPlane(editor, p);
    if (next === null) {
      this.aim = null;
      return;
    }
    // **変わったときだけ知らせる。** 毎回だと動かすたびに全パネルが描き直される
    // （`Select3D` がホバーの変化だけを知らせるのと同じ考え方）
    if (!sameAim(this.aim, next)) {
      this.aim = next;
      editor.notifyUi();
    }
  }

  /**
   * 置く 1 つ。**底が指した面に乗る**ので、机の天板の上にも斜面の上にも置ける。
   *
   * 底面を作図面に合わせるので、`base` は指した点の高さそのもの——
   * 傾けても原点（底面の中心）は動かない（`toWorld3` が原点まわりに回す）。
   */
  private make(editor: Editor, at: Vec3, plane: WorkPlane): Fixture {
    const scene = editor.store.scene;
    const spec = FIXTURE_SPECS[this.kind];
    const level = levelOf(scene, scene.activeLevelId);
    return {
      id: newId("f"),
      kind: this.kind,
      x: at.x,
      y: at.y,
      angle: this.angle,
      size: { ...spec.defaultSize },
      // **作図面の法線にローカルの +z を合わせる。** 床なら null が返る
      tilt: tiltTo(plane.normal, this.angle),
      // 置くときは種別の既定の輪郭。自前の輪郭は押し出しだけが持つ
      outline: null,
      combine: null,
      edge: null,
      // **高さだけは既定に任せない。** 指した点が床とは限らない
      base: at.z - level.floorZ,
      height: null,
      label: spec.defaultLabel,
      layerId: resolveNewLayer(
        scene.layers,
        editor.store.settings.currentLayerId,
        spec.defaultLayer,
      ),
      levelId: scene.activeLevelId,
      attrs: defaultAttrs(),
    };
  }

  /** 作図面の格子と、置こうとしている立体の仮の姿 */
  overlay(editor: Editor): Face3[] {
    const aim = this.aim;
    if (!aim) return [];
    const scene = editor.store.scene;
    const settings = editor.store.settings;
    const step = settings.gridSize > 0 ? settings.gridSize : 500;
    // **置くものの 3 倍ほどの広さを出す。** 刻みが細かいほど桝目が増えるので、
    // 本数ではなく**広さ**で決める。上限は面の数（＝ソートの負荷）のため
    const half = Math.max(
      4,
      Math.min(
        GRID_MAX_HALF,
        Math.round((FIXTURE_SPECS[this.kind].defaultSize.w * 3) / step),
      ),
    );
    const out = planeGridFaces(
      aim.plane,
      aim.at,
      step,
      half,
      GRID_COLOR,
      scene.activeLevelId,
    );

    // **仮の立体は本物と同じ道で作る。** 見えているものと置かれるものがずれない
    const ghost = this.make(editor, aim.at, aim.plane);
    ghost.id = GHOST_ID;
    const staged: Scene = {
      ...scene,
      fixtures: { ...scene.fixtures, [GHOST_ID]: ghost },
    };
    const faces: Face3[] = [];
    buildFixtureFaces(staged, GHOST_ID, faces);
    // 色だけ差し替える。**`ref` は残す**ので、拾う側から見ても図面の実体ではない
    for (const f of faces) out.push({ ...f, color: GHOST_COLOR });
    return out;
  }

  status(editor: Editor): string {
    const spec = FIXTURE_SPECS[this.kind];
    const size = spec.defaultSize;
    const text = isRoundFixture(this.kind)
      ? `φ${size.w}`
      : `${size.w}×${size.h}`;
    if (!this.aim)
      return `${spec.label} (${text}) — 置く面にカーソルを合わせてください`;
    const { at, plane } = this.aim;
    const grid = editor.store.settings.snapGrid
      ? `${editor.store.settings.gridSize}mm 刻み`
      : "刻みなし";
    const lean = tiltTo(plane.normal, this.angle)
      ? "面に沿って傾けて"
      : "立てて";
    return (
      `${spec.label} (${text}) を ${plane.label}の上へ${lean}置く / 高さ ${Math.round(at.z)}mm / ${grid}` +
      " — 頂点へのスナップはまだありません"
    );
  }
}

/** 桝目の数の上限（中心から片側）。帯 1 本が 1 面なので、ここが描画の負荷を決める */
const GRID_MAX_HALF = 24;

const GRID_COLOR = "rgba(37, 99, 235, 0.35)";
const GHOST_COLOR = "rgba(37, 99, 235, 0.45)";

/** 仮の立体の id。図面には入らない */
const GHOST_ID = "__ghost__";

import { defaultAttrs } from '../core/attrs.ts';
import {
  FIXTURE_SPECS, fixtureKindsOf, isRoundFixture, type Fixture, type FixtureKind,
} from '../core/fixture.ts';
import { resolveNewLayer } from '../core/layer.ts';
import { levelOf } from '../core/level.ts';
import { newId, type Scene } from '../core/types.ts';
import type { Editor } from '../ui/editor.ts';
import { buildFixtureFaces } from './fixture3d.ts';
import type { Face3 } from './mesh.ts';
import type { Vec3 } from './mat4.ts';
import { rayPlane } from './ray.ts';
import type { Pointer3D, Tool3D } from './interact.ts';
import { floorPlane, planeFromNormal, planeGridFaces, roundOnPlane, type WorkPlane } from './workplane.ts';

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
 * **立体は傾かない。** `Fixture` は z 軸まわりにしか回らないので、壁の面を
 * 指しても立ったまま、指した点の高さに置かれる。傾けられるように見せるほうが嘘になる。
 */
export class Place3D implements Tool3D {
  /** 置く種別。汎用ソリッドだけ */
  kind: FixtureKind = fixtureKindsOf('solid')[0];
  /** z 軸まわりの向き */
  angle = 0;

  /** いま指している作図面と、その上の点 */
  private aim: { plane: WorkPlane; at: Vec3 } | null = null;

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
    const fixture = this.make(editor, aim.at);
    editor.store.commit(() => {
      editor.store.scene.fixtures[fixture.id] = fixture;
      return true;
    });
    editor.store.setSelection([{ type: 'fixture', id: fixture.id }]);
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
    const scene = editor.store.scene;
    const level = levelOf(scene, scene.activeLevelId);
    const plane = p.hit
      ? planeFromNormal(p.hit.face.normal, p.hit.point, labelOf(p.hit.face.normal))
      : floorPlane(level.floorZ);
    const at = p.hit ? p.hit.point : rayPlane(p.ray, { origin: plane.origin, normal: plane.normal });
    if (!at) {
      this.aim = null;
      return;
    }
    const settings = editor.store.settings;
    const grid = settings.snapGrid ? settings.gridSize : 0;
    const next = { plane, at: roundOnPlane(plane, at, grid) };
    // **変わったときだけ知らせる。** 毎回だと動かすたびに全パネルが描き直される
    // （`Select3D` がホバーの変化だけを知らせるのと同じ考え方）
    if (!sameAim(this.aim, next)) {
      this.aim = next;
      editor.notifyUi();
    }
  }

  /** 置く 1 つ。**底が指した点に乗る**ので、机の天板の上にも壁の途中にも置ける */
  private make(editor: Editor, at: Vec3): Fixture {
    const scene = editor.store.scene;
    const spec = FIXTURE_SPECS[this.kind];
    const level = levelOf(scene, scene.activeLevelId);
    return {
      id: newId('f'),
      kind: this.kind,
      x: at.x,
      y: at.y,
      angle: this.angle,
      size: { ...spec.defaultSize },
      // 置くときは種別の既定の輪郭。自前の輪郭は押し出しだけが持つ
      outline: null,
      // **高さだけは既定に任せない。** 指した点が床とは限らない
      base: at.z - level.floorZ,
      height: null,
      label: spec.defaultLabel,
      layerId: resolveNewLayer(scene.layers, editor.store.settings.currentLayerId, spec.defaultLayer),
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
    const half = Math.max(4, Math.min(GRID_MAX_HALF, Math.round((FIXTURE_SPECS[this.kind].defaultSize.w * 3) / step)));
    const out = planeGridFaces(aim.plane, aim.at, step, half, GRID_COLOR, scene.activeLevelId);

    // **仮の立体は本物と同じ道で作る。** 見えているものと置かれるものがずれない
    const ghost = this.make(editor, aim.at);
    ghost.id = GHOST_ID;
    const staged: Scene = { ...scene, fixtures: { ...scene.fixtures, [GHOST_ID]: ghost } };
    const faces: Face3[] = [];
    buildFixtureFaces(staged, GHOST_ID, faces);
    // 色だけ差し替える。**`ref` は残す**ので、拾う側から見ても図面の実体ではない
    for (const f of faces) out.push({ ...f, color: GHOST_COLOR });
    return out;
  }

  status(editor: Editor): string {
    const spec = FIXTURE_SPECS[this.kind];
    const size = spec.defaultSize;
    const text = isRoundFixture(this.kind) ? `φ${size.w}` : `${size.w}×${size.h}`;
    if (!this.aim) return `${spec.label} (${text}) — 置く面にカーソルを合わせてください`;
    const { at, plane } = this.aim;
    const grid = editor.store.settings.snapGrid ? `${editor.store.settings.gridSize}mm 刻み` : '刻みなし';
    return `${spec.label} (${text}) を ${plane.label}の上へ / 高さ ${Math.round(at.z)}mm / ${grid}`
      + ' — 頂点へのスナップはまだありません';
  }
}

/** 桝目の数の上限（中心から片側）。帯 1 本が 1 面なので、ここが描画の負荷を決める */
const GRID_MAX_HALF = 24;

const GRID_COLOR = 'rgba(37, 99, 235, 0.35)';
const GHOST_COLOR = 'rgba(37, 99, 235, 0.45)';

/** 仮の立体の id。図面には入らない */
const GHOST_ID = '__ghost__';

/** 狙いが動いたか。格子 1 刻みより細かい差は無視する */
const sameAim = (
  a: { plane: WorkPlane; at: Vec3 } | null,
  b: { plane: WorkPlane; at: Vec3 },
): boolean =>
  a !== null && a.plane.label === b.plane.label
  && a.at.x === b.at.x && a.at.y === b.at.y && a.at.z === b.at.z;

/** 作図面の名前。法線の向きだけで決まる */
const labelOf = (normal: Vec3): string => {
  if (normal.z > 0.9) return '上を向いた面';
  if (normal.z < -0.9) return '下を向いた面';
  return Math.abs(normal.z) < 0.1 ? '立った面' : '傾いた面';
};

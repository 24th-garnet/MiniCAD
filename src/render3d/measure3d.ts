import { point3, type Measurement } from "../core/annotation.ts";
import { defaultAttrs } from "../core/attrs.ts";

import { getLayer, LAYER_IDS, resolveNewLayer } from "../core/layer.ts";
import { levelOf } from "../core/level.ts";
import { newId, type Scene } from "../core/types.ts";
import type { Editor } from "../ui/editor.ts";
import {
  aimOnPlane,
  pointMarker,
  sameAim,
  segmentTube,
  type Aim3D,
} from "./aim3d.ts";
import { length3, sub3, vec3, type Vec3 } from "./mat4.ts";
import type { Face3, FaceSource } from "./mesh.ts";
import type { Pointer3D, Tool3D } from "./interact.ts";

/**
 * 3D の中で 2 点間の距離を測る（ワイヤー 5 枚目「距離計測」）。
 *
 * > 距離計測ボタン押下／始点 / 終点を**タップする**指示文章が表示／2点タップ
 *
 * **実体は 1 つも変えていない。** `Measurement` は前から `Point3`（xyz）を持ち、
 * `measuredDistance` も z 込みで出していた。2D の計測ツールが
 * `point3(x, y, 0)` と z を潰していただけで、**足りなかったのは道具のほう**。
 *
 * 測った結果は 2D の計測とまったく同じ実体になるので、インスペクタの欄
 * （座標・自動/手動・メモ）も、JSON の往復も、undo も、そのまま効く。
 *
 * **2D の計測は触らない。** あちらは紙の上で測るものなので z は 0 でよい。
 */
export class Measure3D implements Tool3D {
  /** 1 点目。2 点目を打つと実体になって消える */
  private from: Aim3D | null = null;
  /** いま指している作図面と、その上の点 */
  private aim: Aim3D | null = null;

  isActive(): boolean {
    return this.from !== null;
  }

  cancel(editor: Editor): boolean {
    if (!this.from) return false;
    this.from = null;
    editor.notifyUi();
    return true;
  }

  onPointerDown(editor: Editor, p: Pointer3D): void {
    if (p.button !== 0) return;
    this.aimAt(editor, p);
    const aim = this.aim;
    if (!aim) return;
    if (!this.from) {
      this.from = aim;
      editor.notifyUi();
      return;
    }
    // **同じ点を 2 度叩いただけなら何もしない。** 2D の計測と同じ線引き
    if (length3(sub3(aim.at, this.from.at)) < 1) return;
    this.commit(editor, this.from.at, aim.at);
  }

  onPointerMove(editor: Editor, p: Pointer3D): void {
    this.aimAt(editor, p);
  }

  onPointerUp(): void {}

  onPointerLeave(): void {
    this.aim = null;
  }

  /**
   * 測り終えたら実体にする。
   *
   * **z は階の床からの高さ。** ワールドの z をそのまま入れてはいけない——
   * コメント（`viewer.ts` の `commentScreen`）が `level.floorZ + at.z` と
   * 足し直しているのと同じ約束で、2 階で測ると倍に積み上がる。
   * 2D の計測が 0 を入れているのも「平面は階の床で測っている」から。
   */
  private commit(editor: Editor, a: Vec3, b: Vec3): void {
    const store = editor.store;
    const floor = levelOf(store.scene, store.scene.activeLevelId).floorZ;
    const id = newId("ms");
    const measurement: Measurement = {
      id,
      a: point3(a.x, a.y, a.z - floor),
      b: point3(b.x, b.y, b.z - floor),
      manual: null,
      note: "",
      layerId: resolveNewLayer(
        store.scene.layers,
        store.settings.currentLayerId,
        LAYER_IDS.draft,
      ),
      levelId: store.scene.activeLevelId,
      attrs: defaultAttrs(),
    };
    store.commit(() => {
      store.scene.measurements[id] = measurement;
    });
    store.setSelection([{ type: "measurement", id }]);
    this.from = null;
    // **状況表示を描き直させる。** `commit` は図面が変わったことしか知らせないので、
    // ここで言わないと「終点をクリック」が出たまま残る（画面で見つけた）
    editor.notifyUi();
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

  /** 打った点の印と、測っている最中の線 */
  overlay(editor: Editor): Face3[] {
    const src: FaceSource = {
      ref: null,
      levelId: editor.store.scene.activeLevelId,
    };
    const out: Face3[] = [];
    if (this.from)
      out.push(...pointMarker(this.from, MARKER_MM, MEASURE_COLOR, src));
    if (this.aim)
      out.push(...pointMarker(this.aim, MARKER_MM, MEASURE_COLOR, src));
    if (this.from && this.aim) {
      out.push(
        ...segmentTube(this.from.at, this.aim.at, TUBE_MM, MEASURE_COLOR, src),
      );
    }
    return out;
  }

  status(): string {
    if (!this.from) return "始点をクリック。測った結果は残ります";
    if (!this.aim) return "終点をクリックで確定 / Esc で取り消し";
    const d = length3(sub3(this.aim.at, this.from.at));
    return (
      `${Math.round(d)} mm（${this.aim.plane.label}の上）` +
      " — 終点をクリックで確定 / Esc で取り消し"
    );
  }
}

/** 印の腕の長さと、線の太さ (mm) */
const MARKER_MM = 120;
const TUBE_MM = 12;

const MEASURE_COLOR = "rgba(37, 99, 235, 0.85)";

/**
 * 図面に残っている計測を 3D に出す。**道具を離れても見える。**
 *
 * 3D のメッシュには混ぜない——計測は図面の一部ではなく打ち合わせの道具で、
 * 面として混ぜると当たり判定にも BSP にも入ってしまう。作図の補助と同じ
 * **2 回目の塗り**で重ねる。
 *
 * **画層が見えているものだけ。** 2D と同じ約束。
 */
export function measurementFaces(scene: Scene): Face3[] {
  const out: Face3[] = [];
  for (const m of Object.values(scene.measurements)) {
    if (!getLayer(scene.layers, m.layerId, LAYER_IDS.draft).visible) continue;
    const floor = levelOf(scene, m.levelId).floorZ;
    const a = vec3(m.a.x, m.a.y, floor + m.a.z);
    const b = vec3(m.b.x, m.b.y, floor + m.b.z);
    if (length3(sub3(b, a)) < 1) continue;
    out.push(
      ...segmentTube(a, b, TUBE_MM, DONE_COLOR, {
        ref: null,
        levelId: m.levelId,
      }),
    );
  }
  return out;
}

/** 測り終えたものの色。測っている最中より落ち着かせる */
const DONE_COLOR = "rgba(37, 99, 235, 0.55)";

import { extrusionFixture, selfIntersects } from "../core/extrude.ts";
import { rotateToWorld, tiltTo, type Placed } from "../core/fixture.ts";
import { signedArea, vec, type Vec } from "../core/geometry.ts";
import { resolveNewLayer, LAYER_IDS } from "../core/layer.ts";
import { levelOf } from "../core/level.ts";
import type { Editor } from "../ui/editor.ts";
import {
  aimOnFixedPlane,
  aimOnPlane,
  pointMarker,
  sameAim,
  segmentTube,
  type Aim3D,
} from "./aim3d.ts";
import { dot3, sub3, vec3, type Vec3 } from "./mat4.ts";
import type { Face3, FaceSource } from "./mesh.ts";
import { planeGridFaces, type WorkPlane } from "./workplane.ts";
import type { Pointer3D, Tool3D } from "./interact.ts";

/**
 * 作図面の上に多角形を描いて、**その場で立体にする**（ワイヤー 5 枚目 ※3）。
 *
 * > 直方体、他のツールを使用して作成できない図形は「3D多角形」で作成した 2D に
 * > 対して、「プッシュ/プル」を利用して高さ(H) を与えて立体化する
 *
 * 用語集の作業面の説明もこれを前提にしている——
 * 「3D 空間の任意の角度や位置を平面として設定し、**その面上に直接
 * オブジェクトを描くことができる**」。
 *
 * **新しい実体は 1 つも足していない。** 7 段目（第 5 版）で `tiltTo` が入って、
 * 作図面の上の多角形が**傾きつきの押し出し立体**でそのまま表せるようになった。
 * 平面の記号・ピック・積算・JSON・DXF は、2D から押し出したものと同じ道を通る。
 *
 * **閉じた多角形だけ。** 線は 2D で引く——`Shape` は 2D（x, y）なので、
 * 立った面に引いた線の置き場が無い。
 *
 * | 操作 | |
 * |---|---|
 * | 左クリック | 点を打つ。1 点目で**作図面が決まる** |
 * | 1 点目の近くを左クリック | 閉じて立体にする |
 * | 右クリック | その場で閉じて立体にする（3 点以上あれば） |
 * | Esc | 取り消す |
 */
export class Draw3D implements Tool3D {
  /** 立ち上げる高さ (mm) */
  height = 1000;

  /**
   * 1 点目で決まる作図面。**以後は動かさない。**
   * 動かすと 2 点目が別の面に落ちて、平らでない多角形になる
   */
  private plane: WorkPlane | null = null;
  private points: Vec3[] = [];
  private aim: Aim3D | null = null;

  isActive(): boolean {
    return this.points.length > 0;
  }

  cancel(editor: Editor): boolean {
    if (this.points.length === 0) return false;
    this.points = [];
    this.plane = null;
    editor.notifyUi();
    return true;
  }

  onPointerDown(editor: Editor, p: Pointer3D): void {
    this.aimAt(editor, p);
    const aim = this.aim;
    if (!aim) return;

    // 右クリックはその場で閉じる（CAD の作法）
    if (p.button === 2) {
      this.close(editor);
      return;
    }
    if (p.button !== 0) return;

    // 1 点目の近くを叩いたら閉じる
    if (this.points.length >= 3 && this.nearFirst(editor)) {
      this.close(editor);
      return;
    }
    // **同じ点を 2 度打っても増やさない。** 長さ 0 の辺は立体を破る
    const last = this.points[this.points.length - 1];
    if (last && near3(last, aim.at)) return;

    if (this.points.length === 0) {
      this.plane = aim.plane;
      this.rejected = false;
    }
    this.points.push(aim.at);
    editor.notifyUi();
  }

  onPointerMove(editor: Editor, p: Pointer3D): void {
    this.aimAt(editor, p);
    this.hoveringFirst = this.points.length >= 3 && this.nearFirst(editor);
  }

  onPointerUp(): void {}

  onPointerLeave(): void {
    this.aim = null;
  }

  /** 1 点目のバッジの上にカーソルがあるか。閉じられることを status に出す */
  private hoveringFirst = false;

  private aimAt(editor: Editor, p: Pointer3D): void {
    const next = this.plane
      ? aimOnFixedPlane(editor, p, this.plane)
      : aimOnPlane(editor, p);
    if (next === null) {
      this.aim = null;
      return;
    }
    if (!sameAim(this.aim, next)) {
      this.aim = next;
      editor.notifyUi();
    }
  }

  /**
   * 1 点目に戻ったか。**格子の刻みで測る**ので、細かい図面でも大きい図面でも
   * 「戻った」と言える幅が図面の縮尺に付いてくる。
   */
  private nearFirst(editor: Editor): boolean {
    const first = this.points[0];
    if (!first || !this.aim) return false;
    const grid = editor.store.settings.gridSize;
    return near3(first, this.aim.at, Math.max(CLOSE_MM, grid));
  }

  /**
   * 閉じて立体にする。
   *
   * 輪郭は**立体のローカル軸**で測る。作図面の `u` / `v` ではない——
   * `tiltTo` は底面を作図面に合わせるだけで、ローカルの +x を `u` に
   * 揃えるところまではしない。ずらしたまま使うと形が回る。
   */
  private close(editor: Editor): void {
    const plane = this.plane;
    if (!plane || this.points.length < 3) return;
    const scene = editor.store.scene;

    const tilt = tiltTo(plane.normal, 0);
    const oriented: Placed = { x: 0, y: 0, angle: 0, tilt };
    const ex = rotateToWorld(oriented, vec3(1, 0, 0));
    const ey = rotateToWorld(oriented, vec3(0, 1, 0));

    // 原点は打った点の重心。立体の中に入るので、掴んで動かしやすい
    const n = this.points.length;
    const origin = vec3(
      this.points.reduce((t, q) => t + q.x, 0) / n,
      this.points.reduce((t, q) => t + q.y, 0) / n,
      this.points.reduce((t, q) => t + q.z, 0) / n,
    );
    const local: Vec[] = this.points.map((q) => {
      const d = sub3(q, origin);
      return vec(
        dot3(d, vec3(ex.x, ex.y, ex.z)),
        dot3(d, vec3(ey.x, ey.y, ey.z)),
      );
    });
    // **反時計回りに揃える。** 時計回りのまま押し出すと法線が内を向く
    const outline = signedArea(local) < 0 ? [...local].reverse() : local;

    if (Math.abs(signedArea(outline)) < 1 || selfIntersects(outline)) {
      // **黙って別の形にしない。** 自己交差した形は塗りと当たり判定が食い違う
      this.rejected = true;
      this.points = [];
      this.plane = null;
      editor.notifyUi();
      return;
    }

    const floor = levelOf(scene, scene.activeLevelId).floorZ;
    const fixture = extrusionFixture(scene, {
      outline,
      at: { x: origin.x, y: origin.y, base: origin.z - floor },
      tilt,
      height: this.height,
      layerId: resolveNewLayer(
        scene.layers,
        editor.store.settings.currentLayerId,
        LAYER_IDS.shape,
      ),
    });
    editor.store.commit(() => {
      editor.store.scene.fixtures[fixture.id] = fixture;
      return true;
    });
    editor.store.setSelection([{ type: "fixture", id: fixture.id }]);
    this.rejected = false;
    this.points = [];
    this.plane = null;
    editor.notifyUi();
  }

  /** 直前に断ったか。理由を status に出す */
  private rejected = false;

  /** 打った点・辺・引いている線と、作図面の格子 */
  overlay(editor: Editor): Face3[] {
    const aim = this.aim;
    if (!aim) return [];
    const scene = editor.store.scene;
    const src: FaceSource = { ref: null, levelId: scene.activeLevelId };
    const settings = editor.store.settings;
    const step = settings.gridSize > 0 ? settings.gridSize : 500;
    const out = planeGridFaces(
      aim.plane,
      this.points[0] ?? aim.at,
      step,
      GRID_HALF,
      GRID_COLOR,
      scene.activeLevelId,
    );

    out.push(...pointMarker(aim, MARKER_MM, DRAW_COLOR, src));
    for (let i = 1; i < this.points.length; i++) {
      out.push(
        ...segmentTube(
          this.points[i - 1],
          this.points[i],
          TUBE_MM,
          DRAW_COLOR,
          src,
        ),
      );
    }
    const last = this.points[this.points.length - 1];
    if (last) {
      // 引いている辺と、閉じたときに出来る辺
      out.push(...segmentTube(last, aim.at, TUBE_MM, DRAW_COLOR, src));
      if (this.points.length >= 3) {
        out.push(
          ...segmentTube(aim.at, this.points[0], TUBE_MM, CLOSE_COLOR, src),
        );
      }
    }
    return out;
  }

  status(): string {
    if (this.rejected) {
      return (
        "自己交差した形は立体にできません（塗りと当たり判定が食い違うため）" +
        " — もう一度どうぞ"
      );
    }
    const n = this.points.length;
    if (n === 0)
      return `面にカーソルを合わせて 1 点目をクリック（高さ ${this.height}mm）`;
    if (n < 3) {
      return (
        `${this.aim?.plane.label ?? "作図面"}の上に ${n} 点 / あと ${3 - n} 点で閉じられます` +
        " / Esc で取り消し"
      );
    }
    const how = this.hoveringFirst
      ? "**1 点目をクリックで閉じる**"
      : "1 点目か右クリックで閉じる";
    return `${n} 点 / ${how} / Esc で取り消し`;
  }
}

/** 1 点目に戻ったとみなす距離 (mm) */
const CLOSE_MM = 150;

const near3 = (a: Vec3, b: Vec3, eps = 1): boolean =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < eps;

/** 桝目の数（中心から片側）。`Place3D` と揃える */
const GRID_HALF = 16;
const MARKER_MM = 120;
const TUBE_MM = 14;

const GRID_COLOR = "rgba(37, 99, 235, 0.35)";
const DRAW_COLOR = "rgba(37, 99, 235, 0.9)";
const CLOSE_COLOR = "rgba(37, 99, 235, 0.4)";

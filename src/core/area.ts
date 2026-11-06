import { defaultAttrs } from "./attrs.ts";
import { closedPolygonOf } from "./extrude.ts";
import { pointInPolygon, signedArea } from "./geometry.ts";
import { LAYER_IDS, resolveNewLayer } from "./layer.ts";
import { newId, type EntityRef, type ExteriorArea, type Scene } from "./types.ts";

/**
 * 外部領域（ワイヤー 8 枚目「ペイント／直線・矩形・曲線・**外部領域**」）。
 *
 * **仕様に説明が無い。** すぐ上の「※COOHOMの内容を踏襲」に従って、
 * COOHOM の External Area に合わせた——中庭・テラスなど、既存の部屋の
 * **外側**にある、天井も壁も無い独立したスラブ。
 *
 * **作り方は「押し出す」と同じ作法。** 専用のツールを増やさず、閉じた図形を
 * 選んで変える。1 種別 1 ツールにするとツールバーが破綻する、という
 * この製品の方針に揃えてある。
 */

export interface AreaResult {
  created: EntityRef[];
  /** 閉じていなかった図形の数 */
  notClosed: number;
  /** 部屋と重なっていて断った数 */
  overlapped: number;
}

/**
 * 選んだ図形のうち、閉じているものを外部領域にする。
 *
 * **元の図形は消す。** 外部領域は平面に同じ輪郭を描くので、残すと線が
 * 二重になる（`extrudeShapes` と同じ理由）。undo 1 回で両方戻る。
 *
 * **部屋と重なっていたら断る。** COOHOM の決まり——「外部領域の輪郭は
 * 既存の部屋の外側にしか描けず、交差できない」。黙って重ねると、
 * **同じ床を 2 回数える**ことになり、積算に嘘が流れる。
 */
export function areasFromShapes(
  scene: Scene,
  refs: readonly EntityRef[],
  roomPolygons: readonly (readonly { x: number; y: number }[])[],
): AreaResult {
  const created: EntityRef[] = [];
  let notClosed = 0;
  let overlapped = 0;

  for (const ref of refs) {
    if (ref.type !== "shape") continue;
    const shape = scene.shapes[ref.id];
    if (!shape) continue;
    const poly = closedPolygonOf(scene, ref.id);
    if (!poly) {
      notClosed += 1;
      continue;
    }
    if (overlapsAny(poly, roomPolygons)) {
      overlapped += 1;
      continue;
    }
    const area: ExteriorArea = {
      id: newId("ea"),
      // 反時計回りに揃える。面積の符号を見る側が揃いを前提にする
      outline: signedArea(poly) < 0 ? [...poly].reverse() : poly,
      layerId: resolveNewLayer(scene.layers, shape.layerId, LAYER_IDS.roomName),
      levelId: shape.levelId,
      attrs: defaultAttrs(),
    };
    scene.areas[area.id] = area;
    delete scene.shapes[ref.id];
    created.push({ type: "area", id: area.id });
  }
  return { created, notClosed, overlapped };
}

/**
 * 部屋のどれかと重なっているか。
 *
 * **頂点の内外だけで見る。** 辺どうしの交差まで見るなら多角形のブール演算に
 * なるが、ここで要るのは「重なっているか」の可否だけで、重なり方は要らない。
 * 片方の頂点がもう片方に入っていれば重なっている——完全にすれ違う配置
 * （辺だけが交差して頂点はどちらも外）は、間取りでは起きない。
 */
function overlapsAny(
  poly: readonly { x: number; y: number }[],
  rooms: readonly (readonly { x: number; y: number }[])[],
): boolean {
  for (const room of rooms) {
    if (room.length < 3) continue;
    if (poly.some((p) => pointInPolygon(p, room as { x: number; y: number }[]))) return true;
    if (room.some((p) => pointInPolygon(p, poly as { x: number; y: number }[]))) return true;
  }
  return false;
}

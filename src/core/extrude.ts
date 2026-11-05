import { defaultAttrs } from "./attrs.ts";
import { FIXTURE_SPECS, type Fixture } from "./fixture.ts";
import {
  boundsOf,
  dist,
  segmentIntersection,
  signedArea,
  sub,
  vec,
  type Vec,
} from "./geometry.ts";
import { resolveNewLayer, type LayerId } from "./layer.ts";
import { shapeOutline } from "./shapes.ts";
import { newId, type EntityRef, type Id, type Scene } from "./types.ts";

/**
 * 閉じた図形を押し出して立体にする（ワイヤー 5 枚目の「押し出し」）。
 *
 * **`extrudePrism` は凹多角形でも正しい。** `ccw()` が向きを揃えるだけで凸性を
 * 仮定しておらず、`ctx.fill()` の nonzero 規則と `pointInPolygon` が凹をそのまま扱う
 * （L 字とコの字を 36 方位 × 6 仰角で走査して破れ 0）。**三角形分割は要らない。**
 *
 * **自己交差だけは弾く。** `extrudePrism` は弾かないので、8 の字を渡すと
 * 塗りと当たり判定が食い違う（塗りは nonzero、拾いは `pointInPolygon` の
 * 偶奇で、重なった部分の答えが逆になる）。
 *
 * **閉じているかは図形の種別で判断しない。** `shapeOutline` が返す折れ線が
 * 一周して戻ってくるかを見る。表を 1 枚増やさずに済み、図形の種別を足したときも
 * **自動的に正しくなる**（閉じた形を足せば押し出せる、という状態が勝手に保たれる）。
 */

/** 端点が同じとみなす距離 (mm) */
const CLOSE_EPS = 1e-6;

/**
 * 図形の閉じた輪郭。閉じていなければ null。
 *
 * 円は `arcPolyline` が一周して戻るので、`closed: false` で作られていても
 * ここでは閉じていると見える——**見た目どおりの判断**になる。
 */
export function closedPolygonOf(scene: Scene, shapeId: Id): Vec[] | null {
  const shape = scene.shapes[shapeId];
  if (!shape) return null;
  const segments = shapeOutline(scene, shape);
  if (segments.length < 3) return null;

  // 1 本につながっているか。引出線や寸法のように枝分かれしたものはここで落ちる
  for (let i = 1; i < segments.length; i++) {
    if (dist(segments[i - 1].b, segments[i].a) > CLOSE_EPS) return null;
  }
  if (dist(segments[segments.length - 1].b, segments[0].a) > CLOSE_EPS)
    return null;

  const points = segments
    .map((s) => s.a)
    .filter((p, i, all) => {
      const prev = all[(i + all.length - 1) % all.length];
      return dist(p, prev) > CLOSE_EPS;
    });
  if (points.length < 3) return null;
  if (Math.abs(signedArea(points)) < 1) return null; // 面積が無いものは立てられない
  if (selfIntersects(points)) return null;
  return signedArea(points) < 0 ? [...points].reverse() : points;
}

/**
 * 自分自身と交わるか。**隣り合う辺は端点を共有するので除く。**
 *
 * 辺の数は押し出す形で 100 本ほど（自由曲線から起こした場合）なので、
 * 総当たりの 5000 回で足りる。空間分割は持ち込まない。
 */
export function selfIntersects(points: Vec[]): boolean {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      // 最後の辺は 0 番の辺と端点を共有する
      if (i === 0 && j === n - 1) continue;
      const c = points[j];
      const d = points[(j + 1) % n];
      if (segmentIntersection(a, b, c, d)) return true;
    }
  }
  return false;
}

export interface ExtrudeResult {
  /** 出来た立体 */
  created: EntityRef[];
  /** 押し出せなかった図形の数。画面に出す */
  rejected: number;
}

/**
 * 選んだ図形のうち、閉じているものを立体にする。
 *
 * **元の図形は消す。** 立体は平面にも同じ輪郭を描くので、残すと線が二重になり、
 * 同じ場所に拾えるものが 2 つ並ぶ。undo 1 回で両方戻る。
 */
export function extrudeShapes(
  scene: Scene,
  refs: readonly EntityRef[],
  height: number,
): ExtrudeResult {
  const created: EntityRef[] = [];
  let rejected = 0;

  for (const ref of refs) {
    if (ref.type !== "shape") continue;
    const shape = scene.shapes[ref.id];
    if (!shape) continue;
    const poly = closedPolygonOf(scene, ref.id);
    if (!poly) {
      rejected += 1;
      continue;
    }
    const f = fixtureFrom(scene, poly, height, shape.layerId);
    scene.fixtures[f.id] = f;
    delete scene.shapes[ref.id];
    created.push({ type: "fixture", id: f.id });
  }
  return { created, rejected };
}

/** 輪郭 1 つぶんの立体。**原点は外接矩形の中心**で、向きは 0 */
function fixtureFrom(
  scene: Scene,
  poly: Vec[],
  height: number,
  shapeLayer: LayerId,
): Fixture {
  const b = boundsOf(poly)!;
  const center = vec((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2);
  return extrusionFixture(scene, {
    outline: poly.map((p) => sub(p, center)),
    at: { x: center.x, y: center.y, base: 0 },
    tilt: null,
    height,
    layerId: shapeLayer,
  });
}

/** {@link extrusionFixture} に渡すもの */
export interface ExtrusionPlacement {
  /** **ローカルの**輪郭。反時計回りで、原点（0, 0）はこの中にある */
  outline: Vec[];
  /** 原点のワールド位置。`base` は**階の床からの高さ** */
  at: { x: number; y: number; base: number };
  /** 底面の向き。null なら水平 */
  tilt: { x: number; y: number } | null;
  height: number;
  /** 引き継ぐ画層 */
  layerId: LayerId;
}

/**
 * 押し出した立体を 1 つ作る。**押し出しの形を知っているのはここだけ。**
 *
 * 2D の図形から起こす道（`extrudeShapes`）と、3D の作図面の上で描く道
 * （`render3d/draw3d.ts`）の両方がここを通る。片方だけ直すと、同じ
 * 「押し出し」なのに持ち物が食い違う。
 */
export function extrusionFixture(
  scene: Scene,
  place: ExtrusionPlacement,
): Fixture {
  const b = boundsOf(place.outline)!;
  const spec = FIXTURE_SPECS.extrusion;
  return {
    id: newId("f"),
    kind: "extrusion",
    x: place.at.x,
    y: place.at.y,
    // **向きは 0 のまま。** 形はそのまま輪郭が持っているので、回すと二重に回る
    angle: 0,
    size: {
      w: Math.max(1, b.max.x - b.min.x),
      h: Math.max(1, b.max.y - b.min.y),
    },
    tilt: place.tilt,
    outline: place.outline.map((p) => vec(p.x, p.y)),
    combine: null,
    edge: null,
    base: place.at.base,
    height: Math.max(1, place.height),
    label: spec.defaultLabel,
    // **元の図形の画層を引き継ぐ。** 消えた図形の代わりに立つものなので、
    // 「これから描く画層」ではなく元の画層に揃えるほうが驚きが少ない
    layerId: resolveNewLayer(scene.layers, place.layerId, spec.defaultLayer),
    levelId: scene.activeLevelId,
    attrs: defaultAttrs(),
  };
}

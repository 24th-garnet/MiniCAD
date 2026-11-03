import { defaultAttrs } from './attrs.ts';
import {
  FIXTURE_SPECS, type Fixture,
} from './fixture.ts';
import {
  boundsOf, dist, segmentIntersection, signedArea, sub, vec, type Vec,
} from './geometry.ts';
import { resolveNewLayer, type LayerId } from './layer.ts';
import { shapeOutline } from './shapes.ts';
import { newId, type EntityRef, type Id, type Scene } from './types.ts';

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
  if (dist(segments[segments.length - 1].b, segments[0].a) > CLOSE_EPS) return null;

  const points = segments.map((s) => s.a).filter((p, i, all) => {
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
    if (ref.type !== 'shape') continue;
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
    created.push({ type: 'fixture', id: f.id });
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
  const spec = FIXTURE_SPECS.extrusion;
  return {
    id: newId('f'),
    kind: 'extrusion',
    x: center.x,
    y: center.y,
    // **向きは 0 のまま。** 形はそのまま輪郭が持っているので、回すと二重に回る
    angle: 0,
    size: { w: Math.max(1, b.max.x - b.min.x), h: Math.max(1, b.max.y - b.min.y) },
    outline: poly.map((p) => sub(p, center)),
    combine: null,
    base: 0,
    height: Math.max(1, height),
    label: spec.defaultLabel,
    // **元の図形の画層を引き継ぐ。** 消えた図形の代わりに立つものなので、
    // 「これから描く画層」ではなく元の画層に揃えるほうが驚きが少ない
    layerId: resolveNewLayer(scene.layers, shapeLayer, spec.defaultLayer),
    levelId: scene.activeLevelId,
    attrs: defaultAttrs(),
  };
}

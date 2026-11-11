import { defaultAttrs } from './attrs.ts';
import { groupEntities } from './group.ts';
import {
  add, cross, dist, lineLineIntersection, mul, norm, perp, sub, type Vec,
} from './geometry.ts';
import { newId, type EntityRef, type Id, type Opening, type Scene } from './types.ts';
import { LAYER_IDS, type LayerId } from './layer.ts';
import { clampOpening, nodePos, wallLength, wallsAtNode } from './ops.ts';
import { OPENING_PROFILES } from './opening.ts';
import { nonNegativeOr, positiveOr } from './level.ts';

/**
 * L 型出窓（ワイヤー 8 枚目「L型出窓 ＜住＞」）。
 *
 * **角をまたぐので、1 つの `Opening` では表せない。** `Opening` は 1 本の壁に
 * 付くものだから、どちらの壁に乗せても片側が宙に浮く。だから
 * **窓 2 つ ＋ L 字の張り出し 1 つ**を置いて、まとめて 1 グループにする。
 *
 * - 窓は 2 つとも `bay: null`。穴を開けるだけで、張り出しは持たない
 * - 張り出しは `extrusion` の `Fixture` 1 つ。L 字の輪郭を自分で持つ
 * - 3 つを `Attrs.groupId` で束ねる。1 つ掴めば 3 つ選ばれる
 *
 * **動かすのは断る。** 窓は壁の上の 1 次元の座標（`offset`）で位置を持ち、
 * 張り出しは平面の座標で持つ。まとめて動かすと、2 つの窓がそれぞれの壁で
 * 別々に丸められて角からずれ、L 字だけが素直に動いて**三者がばらける**。
 */

export interface CornerBayOptions {
  /** 角から測った、それぞれの壁の開口幅 (mm) */
  width: number;
  /** 壁の面からの出 (mm) */
  depth: number;
  sillHeight: number | null;
  height: number | null;
  layerId?: LayerId;
}

export const defaultCornerBay = (): CornerBayOptions => ({
  width: 1200,
  depth: 450,
  sillHeight: 800,
  height: 1100,
});

/** 置けない理由。**置けるなら null** */
export function cornerBayBlocker(
  scene: Scene,
  nodeId: Id,
  opts: CornerBayOptions,
): string | null {
  const node = scene.nodes[nodeId];
  if (!node) return 'その角はありません';
  const walls = wallsAtNode(scene, nodeId);
  if (walls.length !== 2) {
    return `L 型出窓は壁 2 本の角に置きます（ここは ${walls.length} 本）`;
  }
  if (walls.some((w) => w.bulge !== 0)) {
    return '円弧壁の角には置けません（L 字の輪郭が壁の面に合いません）';
  }
  const corner = nodePos(scene, nodeId);
  const legs = walls.map((w) => {
    const far = w.a === nodeId ? w.b : w.a;
    return { wall: w, dir: norm(sub(nodePos(scene, far), corner)), length: wallLength(scene, w) };
  });
  if (Math.abs(cross(legs[0].dir, legs[1].dir)) < 1e-6) {
    return 'まっすぐ並んだ壁の間には置けません（角になっていません）';
  }
  for (const leg of legs) {
    if (leg.length < opts.width + 1) {
      return `幅 ${opts.width}mm が壁に収まりません（${Math.round(leg.length)}mm）`;
    }
    if (offsetAtCorner(scene, leg.wall.id, leg.wall.a === nodeId, opts.width) === null) {
      return '同じところに別の建具があります';
    }
  }
  return null;
}

/**
 * 角にいちばん近い、置ける位置（壁の始点から測った `offset`）。
 *
 * **角にぴったり寄せられるわけではない。** `clampOpening` は壁の端から
 * `OPENING_MARGIN` だけ離すので、角には必ず小さな壁が残る——ジャムの無い
 * 建具は作れないので、それでよい。**同じ規則をここでも使う**ので、
 * 手で置いた建具と L 型出窓で寄せ方が食い違わない。
 */
function offsetAtCorner(
  scene: Scene,
  wallId: Id,
  startsHere: boolean,
  width: number,
): number | null {
  const total = wallLength(scene, scene.walls[wallId]);
  const want = startsHere ? width / 2 : total - width / 2;
  const got = clampOpening(scene, wallId, want, width);
  if (got === null) return null;
  // 角から離れるぶんには構わないが、**反対の端まで逃げたら置けていない**
  const fromCorner = startsHere ? got : total - got;
  return fromCorner <= width / 2 + width ? got : null;
}

/**
 * L 型出窓を置く。**置けなければ何も変えずに null。**
 *
 * 返すのは置いた 3 つの実体。呼ぶ側はそのまま選択に入れられる。
 */
export function placeCornerBay(
  scene: Scene,
  nodeId: Id,
  opts: CornerBayOptions,
): EntityRef[] | null {
  if (cornerBayBlocker(scene, nodeId, opts) !== null) return null;
  const corner = nodePos(scene, nodeId);
  const walls = wallsAtNode(scene, nodeId);
  const legs = walls.map((w) => {
    const far = w.a === nodeId ? w.b : w.a;
    const startsHere = w.a === nodeId;
    const length = wallLength(scene, w);
    const offset = offsetAtCorner(scene, w.id, startsHere, opts.width)!;
    return {
      wall: w,
      dir: norm(sub(nodePos(scene, far), corner)),
      length,
      startsHere,
      offset,
      // 角から、窓の遠い端まで
      reach: (startsHere ? offset : length - offset) + opts.width / 2,
    };
  });

  // **外側は 2 本の内角の反対。** 角を回り込む向きで、どちらの壁から見ても外
  const outward = norm(mul(add(legs[0].dir, legs[1].dir), -1));
  const faces = legs.map((leg) => {
    const n = perp(leg.dir);
    const side = cross(leg.dir, outward) > 0 ? 1 : -1;
    // 壁の面まで（厚さの半分）と、そこから張り出した先まで
    const normal = mul(n, side);
    return {
      ...leg,
      normal,
      face: mul(normal, leg.wall.thickness / 2),
      out: mul(normal, leg.wall.thickness / 2 + opts.depth),
    };
  });

  const layerId = opts.layerId ?? LAYER_IDS.opening;
  const created: EntityRef[] = [];
  const profile = OPENING_PROFILES.window;
  const sill = nonNegativeOr(opts.sillHeight, profile.sillHeight);
  const head = sill + positiveOr(opts.height, profile.height);

  for (const leg of faces) {
    const id = newId('o');
    const opening: Opening = {
      id,
      wallId: leg.wall.id,
      // 角にいちばん寄せた位置。寄せ方の規則は手で置くときと同じ
      offset: leg.offset,
      width: opts.width,
      kind: 'window',
      flipX: false,
      flipY: false,
      sillHeight: opts.sillHeight,
      // **張り出しは持たない。** 箱は L 字の `Fixture` が 1 つで受け持つ
      bay: null,
      designation: '',
      leaves: 2,
      height: opts.height,
      layerId,
      attrs: defaultAttrs(),
    };
    scene.openings[id] = opening;
    created.push({ type: 'opening', id });
  }

  const outline = cornerOutline(corner, faces);
  const center = {
    x: outline.reduce((s, p) => s + p.x, 0) / outline.length,
    y: outline.reduce((s, p) => s + p.y, 0) / outline.length,
  };
  const fixtureId = newId('f');
  scene.fixtures[fixtureId] = {
    id: fixtureId,
    kind: 'extrusion',
    x: center.x,
    y: center.y,
    angle: 0,
    tilt: null,
    size: { w: 1, h: 1 },
    // **輪郭は中心を原点にした局所座標。** 角度 0 のまま持つので、
    // 読み戻しても壁との関係が狂わない
    outline: outline.map((p) => sub(p, center)),
    combine: null,
    edge: null,
    base: sill,
    height: head - sill,
    label: '',
    layerId: LAYER_IDS.wall,
    levelId: walls[0].levelId,
    attrs: defaultAttrs(),
  };
  created.push({ type: 'fixture', id: fixtureId });

  // **1 グループにする。** 1 つ掴めば 3 つ選ばれるので、消し忘れが出ない
  groupEntities(scene, created);
  return created;
}

interface Face {
  dir: Vec;
  face: Vec;
  out: Vec;
  /** 角から、窓の遠い端までの距離 */
  reach: number;
}

/**
 * L 字の輪郭。角の外側を回って、2 つの窓の遠い端で閉じる。
 *
 * 角の点は**交点で出す**。それぞれの壁の面を平行移動した直線は、
 * 直角でなくても必ず 1 点で交わる（平行でないことは呼ぶ前に確かめてある）。
 */
function cornerOutline(corner: Vec, faces: Face[]): Vec[] {
  const [p, q] = faces;
  const far = (f: Face, off: Vec): Vec => add(add(corner, mul(f.dir, f.reach)), off);
  const meet = (a: Vec, da: Vec, b: Vec, db: Vec): Vec =>
    lineLineIntersection(a, add(a, da), b, add(b, db))?.point ?? a;

  const outerCorner = meet(add(corner, p.out), p.dir, add(corner, q.out), q.dir);
  const faceCorner = meet(add(corner, p.face), p.dir, add(corner, q.face), q.dir);
  return [
    far(p, p.face),
    far(p, p.out),
    outerCorner,
    far(q, q.out),
    far(q, q.face),
    faceCorner,
  ];
}

/**
 * 選択を動かせない理由。**動かせるなら null。**
 *
 * L 型出窓は窓 2 つ（壁の上の 1 次元の座標）と張り出し 1 つ（平面の座標）で
 * できている。まとめて動かすと、2 つの窓がそれぞれの壁で**別々に丸められて**
 * 角からずれ、L 字だけが素直に動いて三者がばらける。黙ってばらけるより、
 * 断って理由を出すほうがよい。
 */
export function cornerBayMoveBlocker(scene: Scene, refs: readonly EntityRef[]): string | null {
  const groups = cornerBayGroups(scene);
  if (groups.size === 0) return null;
  for (const ref of refs) {
    const attrs = ref.type === 'fixture' ? scene.fixtures[ref.id]?.attrs
      : ref.type === 'opening' ? scene.openings[ref.id]?.attrs
        : null;
    if (attrs?.groupId && groups.has(attrs.groupId)) {
      return 'L 型出窓は動かせません（角に合わせて置くものなので、置き直してください）';
    }
  }
  return null;
}

/** L 型出窓のグループ id。窓 2 つと張り出し 1 つが同じ id を持つ */
function cornerBayGroups(scene: Scene): Set<Id> {
  const out = new Set<Id>();
  for (const f of Object.values(scene.fixtures)) {
    if (f.kind !== 'extrusion' || f.outline === null || !f.attrs.groupId) continue;
    const sharers = Object.values(scene.openings).filter(
      (o) => o.attrs.groupId === f.attrs.groupId,
    );
    if (sharers.length === 2) out.add(f.attrs.groupId);
  }
  return out;
}

/** 距離がいちばん近い角のノード。壁 2 本の角だけを見る */
export function nearestCorner(scene: Scene, p: Vec, tolerance: number): Id | null {
  let best: { id: Id; d: number } | null = null;
  for (const node of Object.values(scene.nodes)) {
    if (node.levelId !== scene.activeLevelId) continue;
    if (wallsAtNode(scene, node.id).length !== 2) continue;
    const d = dist(p, node);
    if (d <= tolerance && (!best || d < best.d)) best = { id: node.id, d };
  }
  return best?.id ?? null;
}

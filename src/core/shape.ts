import { add, dist, mul, norm, perp, sub, type Vec } from './geometry.ts';
import { nodePos, openingsOnWall, wallEnds, wallsAtNode } from './ops.ts';
import type { Opening, Scene, Wall } from './types.ts';

/** 壁を厚みのある矩形として表したときの4隅 */
export function wallQuad(scene: Scene, wall: Wall): Vec[] {
  const [a, b] = wallEnds(scene, wall);
  const d = norm(sub(b, a));
  const n = mul(perp(d), wall.thickness / 2);
  return [add(a, n), add(b, n), sub(b, n), sub(a, n)];
}

export interface OpeningFrame {
  /** 開口の中心（壁芯上） */
  center: Vec;
  /** 壁の進行方向の単位ベクトル */
  dir: Vec;
  /** 壁の法線（進行方向の左） */
  normal: Vec;
  /** 開口の両端（壁芯上） */
  start: Vec;
  end: Vec;
  thickness: number;
  width: number;
}

export function openingFrame(scene: Scene, opening: Opening): OpeningFrame | null {
  const wall = scene.walls[opening.wallId];
  if (!wall) return null;
  const a = nodePos(scene, wall.a);
  const b = nodePos(scene, wall.b);
  const d = norm(sub(b, a));
  if (d.x === 0 && d.y === 0) return null;
  const center = add(a, mul(d, opening.offset));
  return {
    center,
    dir: d,
    normal: perp(d),
    start: add(center, mul(d, -opening.width / 2)),
    end: add(center, mul(d, opening.width / 2)),
    thickness: wall.thickness,
    width: opening.width,
  };
}

export function openingQuad(frame: OpeningFrame): Vec[] {
  const n = mul(frame.normal, frame.thickness / 2 + 1);
  return [add(frame.start, n), add(frame.end, n), sub(frame.end, n), sub(frame.start, n)];
}

export interface Segment {
  a: Vec;
  b: Vec;
}

/**
 * 壁を線分の集合として取り出す。開口部の範囲は抜き、開口の小口には縦線を入れる。
 * 端部の小口は、そこで壁が行き止まりのときだけ描く（角の内側に線が走らないように）。
 *
 * 画面の「輪郭線のみ」表示と DXF 書き出しが、どちらもこの関数の結果を使う。
 */
export function wallOutline(scene: Scene, wall: Wall): Segment[] {
  const [a, b] = wallEnds(scene, wall);
  const total = dist(a, b);
  if (total < 1e-6) return [];
  const d = norm(sub(b, a));
  const n = mul(perp(d), wall.thickness / 2);

  const at = (along: number, side: number): Vec => add(add(a, mul(d, along)), mul(n, side));

  // 開口部で分断された、壁が実在する区間
  const holes = openingsOnWall(scene, wall.id)
    .map((o) => [Math.max(0, o.offset - o.width / 2), Math.min(total, o.offset + o.width / 2)] as const)
    .filter(([lo, hi]) => hi > lo);

  const spans: [number, number][] = [];
  let cursor = 0;
  for (const [lo, hi] of holes) {
    if (lo > cursor) spans.push([cursor, lo]);
    cursor = Math.max(cursor, hi);
  }
  if (cursor < total) spans.push([cursor, total]);

  const segments: Segment[] = [];
  for (const [lo, hi] of spans) {
    if (hi - lo < 1e-6) continue;
    segments.push({ a: at(lo, 1), b: at(hi, 1) });
    segments.push({ a: at(lo, -1), b: at(hi, -1) });
  }

  // 開口部の小口
  for (const [lo, hi] of holes) {
    segments.push({ a: at(lo, 1), b: at(lo, -1) });
    segments.push({ a: at(hi, 1), b: at(hi, -1) });
  }

  // 行き止まりの端部だけ塞ぐ
  if (wallsAtNode(scene, wall.a).length === 1) segments.push({ a: at(0, 1), b: at(0, -1) });
  if (wallsAtNode(scene, wall.b).length === 1) segments.push({ a: at(total, 1), b: at(total, -1) });

  return segments;
}

/** ドアの開き軌跡を、始点・終点・半径・中心で表す（円弧として描くため） */
export interface DoorSwing {
  hinge: Vec;
  radius: number;
  /** 建具を閉めた状態の先端（＝開口の反対側の端） */
  closed: Vec;
  /** 建具を開いた状態の先端 */
  open: Vec;
  /**
   * open から closed へ、ワールド座標（y 上向き）で反時計回りに掃くか。
   * 円弧は描画系ごとに向きの約束が違うので、意味を名前に書いておく。
   */
  ccwFromOpenToClosed: boolean;
}

export function doorSwing(frame: OpeningFrame, flipX: boolean, flipY: boolean): DoorSwing {
  const hinge = flipX ? frame.end : frame.start;
  const dirSign = flipX ? -1 : 1;
  const sideSign = flipY ? -1 : 1;
  const radius = frame.width;
  return {
    hinge,
    radius,
    closed: add(hinge, mul(frame.dir, radius * dirSign)),
    open: add(hinge, mul(frame.normal, radius * sideSign)),
    ccwFromOpenToClosed: sideSign * dirSign < 0,
  };
}




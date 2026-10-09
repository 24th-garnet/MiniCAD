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

export interface Segment {
  a: Vec;
  b: Vec;
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

/**
 * 開口の局所座標 → ワールド座標。
 * `u` は壁の進行方向（開口の中心が 0）、`v` は法線方向（壁芯が 0）。
 * 建具記号の幾何はすべてこの座標で書くと読みやすくなる。
 */
export const openingAt =
  (frame: OpeningFrame) =>
  (u: number, v: number): Vec =>
    add(frame.center, add(mul(frame.dir, u), mul(frame.normal, v)));

/**
 * 開口の一部分だけを切り出した frame。
 * 両開き戸や親子扉を `doorSwing` の使い回しで書くためにある。
 * `u0`/`u1` は開口の中心を 0 とした進行方向の位置。
 */
export function subFrame(frame: OpeningFrame, u0: number, u1: number): OpeningFrame {
  const at = openingAt(frame);
  const start = at(u0, 0);
  const end = at(u1, 0);
  return {
    center: at((u0 + u1) / 2, 0),
    dir: frame.dir,
    normal: frame.normal,
    start,
    end,
    thickness: frame.thickness,
    width: Math.abs(u1 - u0),
  };
}

/**
 * 開口の小口（ジャム）。
 *
 * これは壁の幾何であって建具の記号ではないので、記号の表には入れない。
 * DXF では `wallOutline` が壁側で出しているため、ここを足すと二重線になる。
 */
export function openingJambs(frame: OpeningFrame): Segment[] {
  const half = mul(frame.normal, frame.thickness / 2);
  return [
    { a: add(frame.start, half), b: sub(frame.start, half) },
    { a: add(frame.end, half), b: sub(frame.end, half) },
  ];
}

export function openingQuad(frame: OpeningFrame): Vec[] {
  const n = mul(frame.normal, frame.thickness / 2 + 1);
  return [add(frame.start, n), add(frame.end, n), sub(frame.end, n), sub(frame.start, n)];
}

/**
 * 壁を線分の集合として取り出す。開口部の範囲は抜き、開口の小口には縦線を入れる。
 * 端部の小口は、そこで壁が行き止まりのときだけ描く（角の内側に線が走らないように）。
 *
 * 画面の「輪郭線のみ」表示と DXF 書き出しが、どちらもこの関数の結果を使う。
 */
export interface WallHole {
  opening: Opening;
  /** 壁の始点からの距離 (mm)。0..total にクランプ済み */
  lo: number;
  hi: number;
}

/**
 * 壁を「開口で分断された区間」に分けた結果。
 *
 * 輪郭線（2D）と押し出し（3D）が同じ区間計算を共有するためにある。
 *
 * `holes` は開口の `offset` 昇順。`spans` の計算が「カーソルを単調に進める」
 * 形になっているので、**この並び順が前提**になっている
 * （`openingsOnWall` が offset でソートして返すことに依存している）。
 */
export interface WallSpans {
  a: Vec;
  b: Vec;
  /** 単位ベクトル a → b */
  dir: Vec;
  /** 進行方向の左向き。長さは壁厚の半分 */
  normal: Vec;
  total: number;
  thickness: number;
  holes: WallHole[];
  /** 壁の実体が残っている区間 */
  spans: [number, number][];
}

export function wallSpans(scene: Scene, wall: Wall): WallSpans | null {
  const [a, b] = wallEnds(scene, wall);
  const total = dist(a, b);
  if (total < 1e-6) return null;
  const dir = norm(sub(b, a));
  const normal = mul(perp(dir), wall.thickness / 2);

  const holes: WallHole[] = openingsOnWall(scene, wall.id)
    .map((opening) => ({
      opening,
      lo: Math.max(0, opening.offset - opening.width / 2),
      hi: Math.min(total, opening.offset + opening.width / 2),
    }))
    .filter((h) => h.hi > h.lo);

  const spans: [number, number][] = [];
  let cursor = 0;
  for (const { lo, hi } of holes) {
    if (lo > cursor) spans.push([cursor, lo]);
    cursor = Math.max(cursor, hi);
  }
  if (cursor < total) spans.push([cursor, total]);

  return { a, b, dir, normal, total, thickness: wall.thickness, holes, spans };
}

/**
 * 壁芯からの位置。`side` は +1 / -1 / 0（壁芯上）。
 *
 * **式を整理しないこと。** `a + dir*along + normal*side` にまとめると
 * 浮動小数の結合順が変わり、DXF に書く座標が最下位桁でずれる。
 */
export const wallPointAt = (ws: WallSpans, along: number, side: number): Vec =>
  add(add(ws.a, mul(ws.dir, along)), mul(ws.normal, side));

export function wallOutline(scene: Scene, wall: Wall): Segment[] {
  const ws = wallSpans(scene, wall);
  if (!ws) return [];
  const { total, holes, spans } = ws;
  const at = (along: number, side: number): Vec => wallPointAt(ws, along, side);

  const segments: Segment[] = [];
  for (const [lo, hi] of spans) {
    if (hi - lo < 1e-6) continue;
    segments.push({ a: at(lo, 1), b: at(hi, 1) });
    segments.push({ a: at(lo, -1), b: at(hi, -1) });
  }

  // 開口部の小口
  for (const { lo, hi } of holes) {
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




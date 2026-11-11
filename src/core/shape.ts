import {
  add, ARC_STEP, bulgeArcLength, dist, mul, norm, perp, pointOnBulgeArc, sub,
  type BulgeArc, type Vec,
} from './geometry.ts';
import { nodePos, openingsOnWall, wallArc, wallEnds, wallsAtNode } from './ops.ts';
import type { Opening, Scene, Wall } from './types.ts';

/**
 * 壁の外形。**円弧壁では折れ線になる。**
 *
 * 直線のときの 4 隅は一字も変えていない。SVG と DXF に出る座標が
 * 最下位桁で揺れると、取り込んだ側の差分が全部出てしまう。
 */
export function wallQuad(scene: Scene, wall: Wall): Vec[] {
  const [a, b] = wallEnds(scene, wall);
  const arc = wallArc(scene, wall);
  if (!arc) {
    const d = norm(sub(b, a));
    const n = mul(perp(d), wall.thickness / 2);
    return [add(a, n), add(b, n), sub(b, n), sub(a, n)];
  }
  const ws = wallSpans(scene, wall);
  if (!ws) return [];
  // 外側を行って、内側を戻る
  return [...wallPolyline(ws, 0, ws.total, 1), ...wallPolyline(ws, ws.total, 0, -1)];
}

export interface Segment {
  a: Vec;
  b: Vec;
}

export interface OpeningFrame {
  /** 開口の中心（壁芯上） */
  center: Vec;
  /** 壁の進行方向の単位ベクトル。**円弧では開口の中心での接線** */
  dir: Vec;
  /** 壁の法線（進行方向の左） */
  normal: Vec;
  /** 開口の両端（壁芯上） */
  start: Vec;
  end: Vec;
  /**
   * 両端での法線。**円弧では中心の法線と向きが違う。**
   *
   * 小口（ジャム）は壁を横切る線なので、その位置の法線でないと壁から
   * はみ出すか届かないかになる。直線では `normal` と同じ。
   */
  startNormal: Vec;
  endNormal: Vec;
  thickness: number;
  width: number;
  /** 乗っている壁の区間。円弧の穴を抜くのに要る。直線なら使わない */
  spans: WallSpans | null;
  /** 開口の中心の、壁の始点からの弧長 */
  along: number;
}

export function openingFrame(scene: Scene, opening: Opening): OpeningFrame | null {
  const wall = scene.walls[opening.wallId];
  if (!wall) return null;
  const a = nodePos(scene, wall.a);
  const b = nodePos(scene, wall.b);
  const d = norm(sub(b, a));
  if (d.x === 0 && d.y === 0) return null;
  const arc = wallArc(scene, wall);
  if (!arc) {
    const center = add(a, mul(d, opening.offset));
    const normal = perp(d);
    return {
      center,
      dir: d,
      normal,
      start: add(center, mul(d, -opening.width / 2)),
      end: add(center, mul(d, opening.width / 2)),
      startNormal: normal,
      endNormal: normal,
      thickness: wall.thickness,
      width: opening.width,
      spans: null,
      along: opening.offset,
    };
  }
  // **円弧の上では、両端は弦ではなく弧の上に取る。** 弦で取ると、
  // 建具の幅が広いほど端が壁から浮く（半径 3000・幅 1600 で 106mm）
  const ws = wallSpans(scene, wall);
  if (!ws) return null;
  const along = opening.offset;
  const half = opening.width / 2;
  const dir = wallDirAt(ws, along);
  return {
    center: wallPointAt(ws, along, 0),
    dir,
    normal: perp(dir),
    start: wallPointAt(ws, along - half, 0),
    end: wallPointAt(ws, along + half, 0),
    startNormal: perp(wallDirAt(ws, along - half)),
    endNormal: perp(wallDirAt(ws, along + half)),
    thickness: wall.thickness,
    width: opening.width,
    spans: ws,
    along,
  };
}

/**
 * 開口の局所座標 → ワールド座標。
 * `u` は壁の進行方向（開口の中心が 0）、`v` は法線方向（壁芯が 0）。
 * 建具記号の幾何はすべてこの座標で書くと読みやすくなる。
 *
 * **円弧壁では、この座標そのものが曲がる。** `u` は弧長、`v` はその点の
 * 法線。こうすると建具の記号（ガラス線・框・引き残し）が**何も書き換えずに**
 * 壁に沿う。平らなままにすると、半径 3000・幅 1800 の窓でガラス線が壁から
 * 135mm 浮いて、紙の上で窓だけ外に飛び出して見える。
 *
 * 戸板と開き軌跡は `doorSwing` が別に出す——**板はまっすぐな物**なので、
 * そちらは曲げない。
 */
export const openingAt =
  (frame: OpeningFrame) =>
  (u: number, v: number): Vec => {
    const ws = frame.spans;
    if (!ws?.arc) return add(frame.center, add(mul(frame.dir, u), mul(frame.normal, v)));
    const along = frame.along + u;
    const p = wallPointAt(ws, along, 0);
    return add(p, mul(perp(wallDirAt(ws, along)), v));
  };

/**
 * 開口の局所座標の上で、**壁に沿って**線を引く。
 *
 * `openingAt` は点を返すだけなので、2 点を結んだだけでは円弧壁でも
 * まっすぐな線になる——ガラス線や引き戸の戸が壁から浮いて見える。
 * ここで折る。**直線の壁なら線分 1 本**で、これまでと同じ座標。
 */
export function openingLine(frame: OpeningFrame, u0: number, u1: number, v: number): Segment[] {
  const at = openingAt(frame);
  const ws = frame.spans;
  const steps = ws?.arc
    ? Math.max(1, Math.ceil(Math.abs((ws.arc.sweep * (u1 - u0)) / ws.total) / ARC_STEP))
    : 1;
  const out: Segment[] = [];
  let prev = at(u0, v);
  for (let i = 1; i <= steps; i++) {
    const next = at(u0 + ((u1 - u0) * i) / steps, v);
    out.push({ a: prev, b: next });
    prev = next;
  }
  return out;
}

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
    // **切り出した先は平らな局所座標。** 戸板も召し合わせもまっすぐな板なので、
    // 円弧壁でも曲げない。曲がるのは穴と小口（`openingFrame` が持つ）のほう
    startNormal: frame.normal,
    endNormal: frame.normal,
    spans: null,
    along: frame.along + (u0 + u1) / 2,
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
  // **それぞれの端の法線で引く。** 円弧では中心の法線と向きが違うので、
  // 1 つで代用すると小口が壁から斜めにはみ出す
  const s = mul(frame.startNormal, frame.thickness / 2);
  const e = mul(frame.endNormal, frame.thickness / 2);
  return [
    { a: add(frame.start, s), b: sub(frame.start, s) },
    { a: add(frame.end, e), b: sub(frame.end, e) },
  ];
}

/**
 * 紙の色で抜く範囲。**壁より 1mm 広く取る**ので、輪郭線が残らない。
 *
 * 円弧壁では帯も曲がる。弦の四角で抜くと、膨らんだぶんだけ壁が残る。
 */
export function openingQuad(frame: OpeningFrame): Vec[] {
  const ws = frame.spans;
  if (!ws || !ws.arc) {
    const n = mul(frame.normal, frame.thickness / 2 + 1);
    return [add(frame.start, n), add(frame.end, n), sub(frame.end, n), sub(frame.start, n)];
  }
  const grow = 1 + 2 / frame.thickness; // 片側 1mm 外へ
  const lo = frame.along - frame.width / 2;
  const hi = frame.along + frame.width / 2;
  return [...wallPolyline(ws, lo, hi, grow), ...wallPolyline(ws, hi, lo, -grow)];
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
  /** 円弧壁ならその円弧。直線なら null */
  arc: BulgeArc | null;
}

export function wallSpans(scene: Scene, wall: Wall): WallSpans | null {
  const [a, b] = wallEnds(scene, wall);
  const arc = wallArc(scene, wall);
  // **円弧では弧長。** 開口の `offset` はこの物差しの上の座標なので、
  // 弦に戻すと置いた窓が動く
  const total = arc ? bulgeArcLength(arc) : dist(a, b);
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

  return { a, b, dir, normal, total, thickness: wall.thickness, holes, spans, arc };
}

/**
 * 壁芯からの位置。`side` は +1 / -1 / 0（壁芯上）。
 *
 * **式を整理しないこと。** `a + dir*along + normal*side` にまとめると
 * 浮動小数の結合順が変わり、DXF に書く座標が最下位桁でずれる。
 * **直線の道は 1 字も変えていない**ので、円弧を足しても既存の図面の
 * 書き出しは 1 バイトも動かない。
 *
 * 円弧では `along` は**始点からの弧長**で、法線はその点の接線から出す。
 */
export const wallPointAt = (ws: WallSpans, along: number, side: number): Vec => {
  if (!ws.arc) return add(add(ws.a, mul(ws.dir, along)), mul(ws.normal, side));
  const t = along / ws.total;
  const center = pointOnBulgeArc(ws.arc, t);
  return add(center, mul(perp(wallDirAt(ws, along)), (ws.thickness / 2) * side));
};

/** 壁の上の点での進行方向（単位）。円弧ではその点の接線 */
export function wallDirAt(ws: WallSpans, along: number): Vec {
  if (!ws.arc) return ws.dir;
  const angle = ws.arc.from + ws.arc.sweep * (along / ws.total);
  const sign = ws.arc.sweep >= 0 ? 1 : -1;
  return { x: -Math.sin(angle) * sign, y: Math.cos(angle) * sign };
}

/**
 * 壁に沿って `from` から `to` まで並べた点。`side` は壁芯からの向き。
 *
 * **直線なら 2 点だけ**を返すので、これまでと同じ 1 本の線分になる。
 * 円弧は `ARC_STEP` で刻む——平面も SVG も DXF も折れ線で出すので、
 * 折るのはここ 1 か所でよい。
 */
export function wallPolyline(ws: WallSpans, from: number, to: number, side: number): Vec[] {
  const steps = ws.arc
    ? Math.max(1, Math.ceil(Math.abs((ws.arc.sweep * (to - from)) / ws.total) / ARC_STEP))
    : 1;
  const out: Vec[] = [];
  for (let i = 0; i <= steps; i++) {
    out.push(wallPointAt(ws, from + ((to - from) * i) / steps, side));
  }
  return out;
}

/** 点の列を、隣り合う 2 点ずつの線分にする */
function polylineSegments(points: Vec[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i + 1 < points.length; i++) out.push({ a: points[i], b: points[i + 1] });
  return out;
}

export function wallOutline(scene: Scene, wall: Wall): Segment[] {
  const ws = wallSpans(scene, wall);
  if (!ws) return [];
  const { total, holes, spans } = ws;
  const at = (along: number, side: number): Vec => wallPointAt(ws, along, side);

  const segments: Segment[] = [];
  for (const [lo, hi] of spans) {
    if (hi - lo < 1e-6) continue;
    // 直線なら 2 点＝線分 1 本で、これまでと同じ座標になる
    segments.push(...polylineSegments(wallPolyline(ws, lo, hi, 1)));
    segments.push(...polylineSegments(wallPolyline(ws, lo, hi, -1)));
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




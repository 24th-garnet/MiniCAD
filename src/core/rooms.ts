import {
  add,
  angleOf,
  centroid,
  cross,
  dist,
  mul,
  norm,
  perp,
  pointInPolygon,
  signedArea,
  sub,
  vec,
  type Vec,
} from './geometry.ts';
import { nodePos } from './ops.ts';
import type { Id, Room, Scene } from './types.ts';

interface HalfEdge {
  key: string;
  from: Id;
  to: Id;
  wallId: Id;
  angle: number;
}

const heKey = (from: Id, to: Id): string => `${from}>${to}`;

/**
 * 壁グラフの平面フェイスを辿って部屋を検出する。
 *
 * 各有向半辺 (u→v) に対し、v における逆辺 (v→u) から「反時計回り順で1つ手前」の
 * 出辺を次の辺とする。この辿り方だと内部フェイスは反時計回り（符号付き面積が正）、
 * 外周フェイスは時計回り（負）になるので、正のものだけを部屋として拾う。
 */
export function detectRooms(scene: Scene): Room[] {
  const halfEdges = new Map<string, HalfEdge>();
  const outgoing = new Map<Id, HalfEdge[]>();

  for (const wall of Object.values(scene.walls)) {
    if (wall.a === wall.b) continue;
    const pa = nodePos(scene, wall.a);
    const pb = nodePos(scene, wall.b);
    if (dist(pa, pb) < 1e-6) continue;
    const forward: HalfEdge = {
      key: heKey(wall.a, wall.b),
      from: wall.a,
      to: wall.b,
      wallId: wall.id,
      angle: angleOf(sub(pb, pa)),
    };
    const backward: HalfEdge = {
      key: heKey(wall.b, wall.a),
      from: wall.b,
      to: wall.a,
      wallId: wall.id,
      angle: angleOf(sub(pa, pb)),
    };
    for (const he of [forward, backward]) {
      halfEdges.set(he.key, he);
      const list = outgoing.get(he.from);
      if (list) list.push(he);
      else outgoing.set(he.from, [he]);
    }
  }

  for (const list of outgoing.values()) {
    list.sort((p, q) => p.angle - q.angle);
  }

  const indexInRing = new Map<string, number>();
  for (const list of outgoing.values()) {
    list.forEach((he, i) => indexInRing.set(he.key, i));
  }

  const nextHalfEdge = (he: HalfEdge): HalfEdge | null => {
    const ring = outgoing.get(he.to);
    if (!ring || ring.length === 0) return null;
    const reverseIdx = indexInRing.get(heKey(he.to, he.from));
    if (reverseIdx === undefined) return null;
    const next = ring[(reverseIdx - 1 + ring.length) % ring.length];
    return next ?? null;
  };

  const visited = new Set<string>();
  const rooms: Room[] = [];

  for (const start of halfEdges.values()) {
    if (visited.has(start.key)) continue;
    const cycle: HalfEdge[] = [];
    let current: HalfEdge | null = start;
    // 安全弁: 壊れたグラフで無限ループしないよう半辺数で打ち切る
    for (let guard = 0; guard <= halfEdges.size && current; guard++) {
      if (visited.has(current.key)) break;
      visited.add(current.key);
      cycle.push(current);
      current = nextHalfEdge(current);
      if (current && current.key === start.key) break;
    }
    if (cycle.length < 3) continue;

    const polygon = cycle.map((he) => nodePos(scene, he.from));
    const area = signedArea(polygon);
    // 負=外周フェイス、ほぼ0=行き止まり壁の往復
    if (area <= 1e-3) continue;

    const wallIds = cycle.map((he) => he.wallId);
    const thicknesses = cycle.map((he) => scene.walls[he.wallId]?.thickness ?? 0);
    const innerPolygon = offsetInward(polygon, thicknesses);
    const innerArea = Math.abs(signedArea(innerPolygon));

    rooms.push({
      polygon,
      innerPolygon,
      area: area / 1e6,
      innerArea: innerArea / 1e6,
      center: centroid(innerPolygon.length >= 3 ? innerPolygon : polygon),
      wallIds,
      name: null,
      labelId: null,
    });
  }

  attachLabels(scene, rooms);
  return rooms;
}

/**
 * 反時計回りポリゴンの各辺を内側（進行方向の左）へ壁厚の半分だけ寄せ、
 * 隣り合う辺の直線交点を新しい角とする。平行な辺はオフセット点をそのまま使う。
 */
function offsetInward(polygon: Vec[], thicknesses: number[]): Vec[] {
  const n = polygon.length;
  if (n < 3) return polygon.map((p) => ({ ...p }));

  const lines = polygon.map((p, i) => {
    const q = polygon[(i + 1) % n];
    const d = norm(sub(q, p));
    const inward = mul(perp(d), (thicknesses[i] ?? 0) / 2);
    return { point: add(p, inward), dir: d };
  });

  const result: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const prev = lines[(i - 1 + n) % n];
    const curr = lines[i];
    const denom = cross(prev.dir, curr.dir);
    if (Math.abs(denom) < 1e-9) {
      result.push({ ...curr.point });
      continue;
    }
    const t = cross(sub(curr.point, prev.point), curr.dir) / denom;
    result.push(add(prev.point, mul(prev.dir, t)));
  }
  return result;
}

function attachLabels(scene: Scene, rooms: Room[]): void {
  for (const label of Object.values(scene.roomLabels)) {
    const p = vec(label.x, label.y);
    // 小さい部屋を優先して拾う（入れ子になった部屋でラベルが外側に取られないように）
    const candidates = rooms
      .filter((r) => pointInPolygon(p, r.polygon))
      .sort((a, b) => a.area - b.area);
    const target = candidates[0];
    if (target) {
      target.name = label.name;
      target.labelId = label.id;
    }
  }
}

/**
 * 壁の寸法線をどちら側に出すかを決める。
 * 法線側に部屋があれば反対側（＝室外）へ、なければ法線側へ出す。
 * これで外壁の寸法は建物の外、間仕切りの寸法は片側に揃う。
 */
export function dimensionSide(rooms: Room[], at: Vec, normal: Vec, probe: number): number {
  const front = add(at, mul(normal, probe));
  const back = sub(at, mul(normal, probe));
  const frontInside = rooms.some((r) => pointInPolygon(front, r.polygon));
  const backInside = rooms.some((r) => pointInPolygon(back, r.polygon));
  if (frontInside && !backInside) return -1;
  return 1;
}

/** 点を含む部屋のうち最も小さいもの */
export function roomAt(rooms: Room[], p: Vec): Room | null {
  const hits = rooms.filter((r) => pointInPolygon(p, r.polygon)).sort((a, b) => a.area - b.area);
  return hits[0] ?? null;
}

/** 面積 (m^2) を帖数に換算する。1帖 = 1.62 m^2（不動産公正競争規約の下限値） */
export const toTatami = (areaM2: number): number => areaM2 / 1.62;

/**
 * ポリゴンの周長 (mm)。巾木・回り縁の長さの素になる。
 *
 * 面積は `signedArea` が出すのに、周長を出す関数がこれまで無かった。
 */
export function perimeterOf(polygon: Vec[]): number {
  if (polygon.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    sum += dist(polygon[i], polygon[(i + 1) % polygon.length]);
  }
  return sum;
}

/**
 * 部屋の中に入れ子になっている部屋（柱型・PS・内部に独立して建つ箱）を探す。
 *
 * `detectRooms` は壁グラフの平面フェイスを列挙するだけなので、**外側の部屋の面積が
 * 内側の島のぶんを二重に含んでいる**。数量を拾うときはこれを引かないと、床も天井も
 * 仕上げが多すぎる数になる。
 *
 * 包含は**面積の大小ではなく内法ポリゴンの代表点**で判定する。壁芯で判定すると、
 * 壁を共有する隣り合った部屋が「内側」と誤判定される。
 *
 * 返すのは添字の対応表（外側 → 内側たち）。`Room` を書き換えないのは、画面の
 * 面積表示を変えるのが**別の議論**だから。書き出し側が控除して使う。
 */
export function nestingOf(rooms: Room[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let inner = 0; inner < rooms.length; inner++) {
    const p = rooms[inner].center;
    let best = -1;
    let bestArea = Infinity;
    for (let outer = 0; outer < rooms.length; outer++) {
      if (outer === inner) continue;
      if (rooms[outer].area <= rooms[inner].area) continue;
      if (!pointInPolygon(p, rooms[outer].polygon)) continue;
      // 何重にも入れ子なら、**一番内側の親**に付ける
      if (rooms[outer].area < bestArea) {
        best = outer;
        bestArea = rooms[outer].area;
      }
    }
    if (best >= 0) {
      const got = out.get(best);
      if (got) got.push(inner);
      else out.set(best, [inner]);
    }
  }
  return out;
}

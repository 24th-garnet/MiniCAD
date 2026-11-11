import {
  add,
  arcFromBulge,
  centroid,
  dist,
  mul,
  pointInPolygon,
  signedArea,
  sub,
  vec,
  type BulgeArc,
  type Vec,
} from "./geometry.ts";
import { nodePos } from "./ops.ts";
import {
  boundaryArea,
  boundaryPerimeter,
  departure,
  offsetInward,
  toPolyline,
  type BoundaryEdge,
} from "./roomBoundary.ts";
import { FIXTURE_SPECS, outline } from "./fixture.ts";
import { levelOf } from "./level.ts";
import type { ExteriorArea, Id, Room, Scene } from "./types.ts";

interface HalfEdge {
  key: string;
  from: Id;
  to: Id;
  wallId: Id;
  /** 節点から出てゆく向き。**円弧ではその点の接線** */
  angle: number;
  /** 曲がり方（符号つき曲率）。接線が同じ辺を並べ分けるのに使う */
  turn: number;
  /** 進む向きの円弧。直線なら null */
  arc: BulgeArc | null;
}

/**
 * 半辺の鍵。**どの壁かまで入れる。**
 *
 * 節点の対だけだと、**同じ 2 つの節点を結ぶ壁が 2 本あるとき**（円弧 2 本の
 * レンズ形、円弧と直線）に鍵がぶつかり、片方が Map から消える。消えた側は
 * 面の辿りで見つからないので、部屋が 1 つも出てこない。
 */
const heKey = (from: Id, to: Id, wallId: Id): string => `${from}>${to}#${wallId}`;

/**
 * 壁グラフの平面フェイスを辿って部屋を検出する。**全ての階を返す。**
 *
 * 各有向半辺 (u→v) に対し、v における逆辺 (v→u) から「反時計回り順で1つ手前」の
 * 出辺を次の辺とする。この辿り方だと内部フェイスは反時計回り（符号付き面積が正）、
 * 外周フェイスは時計回り（負）になるので、正のものだけを部屋として拾う。
 *
 * **階で絞る処理は要らない。** ノードが階を持ち（`findOrCreateNode` は同じ階の
 * ノードしか使い回さない）、壁は両端ノードと同じ階にしか作れない（`addWall`）ので、
 * **ノードの同一性だけでグラフが階ごとに分かれる**。ここに階の判定を足すと、
 * 同じことを二重に保証して食い違う余地が生まれる。
 * 部屋がどの階かは `room.levelId` が持つ（壁から引き写す）。
 */
export function detectRooms(scene: Scene): Room[] {
  const halfEdges = new Map<string, HalfEdge>();
  const outgoing = new Map<Id, HalfEdge[]>();

  for (const wall of Object.values(scene.walls)) {
    if (wall.a === wall.b) continue;
    // **床に着かない壁は部屋を仕切らない。** LDK とキッチンのあいだの垂れ壁で
    // 部屋が 2 つに割れると、床の数量が合わなくなる。天井は割れるが、
    // それは天井伏図の話で、部屋の床の話ではない
    if (wall.base > 0) continue;
    const pa = nodePos(scene, wall.a);
    const pb = nodePos(scene, wall.b);
    if (dist(pa, pb) < 1e-6) continue;
    // **進む向きの円弧。** 逆向きは膨らみの符号を裏返す——
    // 同じ弧を反対から辿るので、曲がる向きも反対になる
    const ahead = arcFromBulge(pa, pb, wall.bulge);
    const back = arcFromBulge(pb, pa, -wall.bulge);
    const out = departure(pa, pb, ahead);
    const home = departure(pb, pa, back);
    const forward: HalfEdge = {
      key: heKey(wall.a, wall.b, wall.id),
      from: wall.a,
      to: wall.b,
      wallId: wall.id,
      angle: out.angle,
      turn: out.turn,
      arc: ahead,
    };
    const backward: HalfEdge = {
      key: heKey(wall.b, wall.a, wall.id),
      from: wall.b,
      to: wall.a,
      wallId: wall.id,
      angle: home.angle,
      turn: home.turn,
      arc: back,
    };
    for (const he of [forward, backward]) {
      halfEdges.set(he.key, he);
      const list = outgoing.get(he.from);
      if (list) list.push(he);
      else outgoing.set(he.from, [he]);
    }
  }

  for (const list of outgoing.values()) {
    // **接線が同じなら曲がり方で分ける。** 円弧に接する直線が節点から
    // 出ていると、向きだけでは並び順が決まらない。左へ曲がるほうが
    // 反時計回りの並びでは後に来る
    list.sort((p, q) => p.angle - q.angle || p.turn - q.turn);
  }

  const indexInRing = new Map<string, number>();
  for (const list of outgoing.values()) {
    list.forEach((he, i) => indexInRing.set(he.key, i));
  }

  const nextHalfEdge = (he: HalfEdge): HalfEdge | null => {
    const ring = outgoing.get(he.to);
    if (!ring || ring.length === 0) return null;
    // **同じ壁の逆向きの辺。** 別の壁の逆辺を掴むと、面が隣へ飛ぶ
    const reverseIdx = indexInRing.get(heKey(he.to, he.from, he.wallId));
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
    // **円弧なら 2 本でも部屋になる。** 同じ 2 つの節点を結ぶ円弧 2 本で
    // レンズ形の部屋ができる。直線だけの 2 本は面積が 0 になるので、
    // ここで弾かなくても下の面積の判定が落とす
    if (cycle.length < 2) continue;
    if (cycle.length === 2 && cycle.every((he) => he.arc === null)) continue;

    const edges: BoundaryEdge[] = cycle.map((he, i) => {
      const a = nodePos(scene, he.from);
      const b = nodePos(scene, cycle[(i + 1) % cycle.length].from);
      return he.arc ? { kind: "arc", a, b, arc: he.arc } : { kind: "line", a, b };
    });

    // **閉じた式で測る。** 折れ線に潰してから測ると、円弧の分だけ必ず小さく出る
    const area = boundaryArea(edges);
    // 負=外周フェイス、ほぼ0=行き止まり壁の往復
    if (area <= 1e-3) continue;

    const wallIds = cycle.map((he) => he.wallId);
    const thicknesses = cycle.map(
      (he) => scene.walls[he.wallId]?.thickness ?? 0,
    );
    const innerEdges = offsetInward(edges, thicknesses);
    const polygon = toPolyline(edges);
    const innerPolygon = toPolyline(innerEdges);
    const innerArea = Math.abs(boundaryArea(innerEdges));
    const levelId = scene.walls[wallIds[0]]?.levelId ?? scene.activeLevelId;
    const voidArea = voidAreaIn(scene, innerPolygon, levelId);

    rooms.push({
      polygon,
      innerPolygon,
      area: area / 1e6,
      innerArea: innerArea / 1e6,
      voidArea: voidArea / 1e6,
      floorArea: Math.max(0, innerArea - voidArea) / 1e6,
      perimeter: boundaryPerimeter(innerEdges),
      center: centroid(innerPolygon.length >= 3 ? innerPolygon : polygon),
      wallIds,
      levelId,
      outdoor: false,
      name: null,
      labelId: null,
    });
  }

  for (const area of Object.values(scene.areas)) {
    rooms.push(exteriorRoom(scene, area));
  }

  attachLabels(scene, rooms);
  return rooms;
}

/**
 * 外部領域を部屋の形にする（ワイヤー 8 枚目「外部領域」）。
 *
 * **壁が無いので内法も無い。** 壁芯と内法が同じ輪郭になり、`wallIds` は空。
 * だから壁面積も開口も出ない——`measures.ts` は空の配列をそのまま扱える。
 *
 * **吹抜は同じように抜く。** テラスの真ん中に吹抜があれば床は無い。
 * 屋内と別の規則にする理由が無い。
 */
function exteriorRoom(scene: Scene, area: ExteriorArea): Room {
  // 反時計回りに揃える。面積の符号を見る側（`roomAt` など）が揃いを前提にする
  const polygon =
    signedArea(area.outline) < 0 ? [...area.outline].reverse() : [...area.outline];
  const raw = Math.abs(signedArea(polygon));
  const voidArea = voidAreaIn(scene, polygon, area.levelId);
  return {
    polygon,
    innerPolygon: polygon,
    area: raw / 1e6,
    innerArea: raw / 1e6,
    // 外部領域は壁を持たないので、輪郭そのものが周長
    perimeter: perimeterOf(polygon),
    voidArea: voidArea / 1e6,
    floorArea: Math.max(0, raw - voidArea) / 1e6,
    center: centroid(polygon),
    wallIds: [],
    levelId: area.levelId,
    outdoor: true,
    name: null,
    labelId: null,
  };
}

/**
 * 部屋の中にある吹抜・PS・煙道の合計面積 (mm^2)。
 *
 * **吹抜は部屋ではない。部屋の中の穴。** 壁グラフには参加しないので、
 * フェイス探索は何も変わらない——中心が内法ポリゴンに入っているかで数えるだけ。
 *
 * **中心で判定する。** 部分的にはみ出した吹抜を面積で按分すると、多角形の
 * 交差が要る。はみ出した吹抜は作図の誤りなので、厳密に扱う価値がない。
 * 入っているなら全部、入っていないなら 0 とはっきりさせる。
 */
/**
 * 床に空いている穴の面積。**その階の吹抜だけを抜く。**
 *
 * 階を見ないと、2 階の吹抜が真下の 1 階の床から引かれる。平面では同じ
 * 場所に重なるので、1 階の床が吹抜のぶんだけ黙って足りなくなる。
 */
function voidAreaIn(scene: Scene, innerPolygon: Vec[], levelId: Id): number {
  if (innerPolygon.length < 3) return 0;
  let total = 0;
  for (const f of Object.values(scene.fixtures)) {
    if (f.levelId !== levelId) continue;
    if (!FIXTURE_SPECS[f.kind].floorHole) continue; // 天窓は立体にならないが、抜くのは屋根
    if (!pointInPolygon(vec(f.x, f.y), innerPolygon)) continue;
    total += Math.abs(signedArea(outline(f, levelOf(scene, f.levelId))));
  }
  return total;
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
export function dimensionSide(
  rooms: Room[],
  at: Vec,
  normal: Vec,
  probe: number,
): number {
  const front = add(at, mul(normal, probe));
  const back = sub(at, mul(normal, probe));
  const frontInside = rooms.some((r) => pointInPolygon(front, r.polygon));
  const backInside = rooms.some((r) => pointInPolygon(back, r.polygon));
  if (frontInside && !backInside) return -1;
  return 1;
}

/** 点を含む部屋のうち最も小さいもの */
/**
 * 点を含む部屋。**階を渡せばその階だけを見る。**
 *
 * 階を渡さないと、2 階の部屋が真下の 1 階の点を拾う。平面では同じ場所に
 * 重なるので、どちらが当たるかは面積の大小で決まってしまう。
 */
export function roomAt(rooms: Room[], p: Vec, levelId?: Id): Room | null {
  const hits = rooms
    .filter((r) => (levelId === undefined || r.levelId === levelId) && pointInPolygon(p, r.polygon))
    .sort((a, b) => a.area - b.area);
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
      // **入れ子は同じ階の中だけ。** 階が違えば、平面で重なっていても
      // 上の部屋が下の部屋の中にあるわけではない
      if (rooms[outer].levelId !== rooms[inner].levelId) continue;
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

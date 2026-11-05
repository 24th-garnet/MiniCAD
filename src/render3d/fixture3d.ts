import {
  FIXTURE_SPECS,
  baseOf,
  isStairKind,
  localOutline,
  localRange,
  rotateToWorld,
  stairTreads,
  toWorld3,
  type Fixture,
  type FixtureKind,
} from "../core/fixture.ts";
import { isSnappable } from "../core/entity.ts";
import { levelOf, type Level } from "../core/level.ts";
import { combineFingerprint } from "../core/combine.ts";
import {
  edgeRings,
  hasTopBottomEdge,
  insetOutline,
  maxInsetOf,
} from "../core/edge3d.ts";
import { csgOperate } from "./csg.ts";
import { vec, type Vec } from "../core/geometry.ts";
import { theme } from "../render/theme.ts";
import type { Id, Scene } from "../core/types.ts";
import {
  extrudePrism,
  polygonFace,
  type Face3,
  type FaceSource,
} from "./mesh.ts";
import { vec3, type Vec3 } from "./mat4.ts";

/**
 * 構造物を立体にする。
 *
 * **平面の表（`core/fixture.ts`）とは別の表にしてある。** `core/` は DOM にも
 * 描画にも触らない規則で、平面の `Primitive` は中間表現なので core に置けるが、
 * 立体の組み立ては `render3d/` の持ち物。種別を足したとき**両方**を埋めないと
 * 型検査が止まる、という性質はどちらの表でも同じように効く。
 *
 * 箱で済まないものがある:
 * - **階段は段で作る。** 箱にすると嘘になる（既存のブロックの階段が 3D で
 *   立たないのは、箱で表すくらいなら出さない方がましだと判断したため）。
 *   段が出せるなら、出す方がよい
 * - **スロープは楔。** 上り口から上端まで一定の勾配で上がる
 * - **吹抜は穴なので何も出さない。** 床を抜くのはまだ出来ていない
 */
type SolidBuilder = (
  f: Fixture,
  level: Level,
  src: FaceSource,
  out: Face3[],
) => void;

/** 柱と梁は躯体なので壁と同じ色にする */
const structural: SolidBuilder = (f, level, src, out) => {
  const { z0, z1 } = localRange(f, level);
  // 柱にもテーパを付けられる。段の積み方は汎用ソリッドと同じ
  if (hasTopBottomEdge(f.edge))
    extrudeProfile(f, localOutline(f), z0, z1, theme.wall3d, src, out);
  else extrudePrism(localOutline(f), z0, z1, theme.wall3d, "wall", src, out);
};

/**
 * 段をひとつずつ押し出す。
 *
 * 長手（ローカル y）方向に等分し、i 段目は上端が `z0 + (i+1) * 蹴上`。
 * 踏面の数は平面の記号（`stepGlyph`）と同じ式で決めるので、**2D の段板の本数と
 * 3D の段数が必ず一致する**。
 */
/**
 * 階段。**踏面の形は平面の記号と同じ `stairTreads` から引く。**
 *
 * 以前は段数の式が平面と 3D に 1 つずつあり、片方を直すと図と立体がずれた。
 * コの字・L 字・回り段は踏面が矩形ですらないので、式の二重管理はもう無理。
 */
const steps: SolidBuilder = (f, level, src, out) => {
  if (!isStairKind(f.kind)) return;
  const { z0, z1 } = localRange(f, level);
  const treads = stairTreads(f.kind, f.size).treads;
  const rise = (z1 - z0) / treads.length;
  treads.forEach((tread, i) => {
    extrudePrism(
      tread.poly,
      z0,
      z0 + rise * (i + 1),
      theme.furniture3d,
      "furniture",
      src,
      out,
    );
  });
};

/**
 * 楔。上り口（ローカル y の負側）が下端、上端が上端。
 *
 * `extrudePrism` は上下が平らな角柱しか作れないので、ここだけ面を直に組む。
 * 刻んで階段にすると、スロープなのに段に見える。
 */
const wedge: SolidBuilder = (f, level, src, out) => {
  const { z0, z1 } = localRange(f, level);
  const w = f.size.w / 2;
  const h = f.size.h / 2;
  const at = (x: number, y: number): Vec => vec(x, y);
  const lo0 = at(-w, -h);
  const lo1 = at(w, -h);
  const hi1 = at(w, h);
  const hi0 = at(-w, h);
  const color = theme.furniture3d;

  // 斜めの上面
  push(out, [p3(lo0, z0), p3(lo1, z0), p3(hi1, z1), p3(hi0, z1)], color, src);
  // 下の面（裏向き）
  push(out, [p3(hi0, z0), p3(hi1, z0), p3(lo1, z0), p3(lo0, z0)], color, src);
  // 上端の立ち上がり
  push(out, [p3(hi1, z0), p3(hi0, z0), p3(hi0, z1), p3(hi1, z1)], color, src);
  // 両側の三角
  push(out, [p3(lo1, z0), p3(hi1, z0), p3(hi1, z1)], color, src);
  push(out, [p3(hi0, z0), p3(lo0, z0), p3(hi0, z1)], color, src);
};

const nothing: SolidBuilder = () => {};

const p3 = (p: Vec, z: number): Vec3 => vec3(p.x, p.y, z);

const push = (
  out: Face3[],
  points: Vec3[],
  color: string,
  src: FaceSource,
): void => {
  out.push(polygonFace(points, color, "furniture", src));
};

// ---- ここから汎用ソリッド（ワイヤー 5 枚目の「基本形状の挿入」）----
//
// **直方体・三角柱・垂直の円筒は柱と 1 行も違わない。** 底面を押し出すだけなので
// `extrudePrism` で足りる。あれは**上下が平らな角柱**しか作れないので、
// 円錐・球・半球と寝かせた円筒だけ、`wedge` と同じく面を直に組む。
//
// **バケットは `wall`。** ソリッドは不透明な実体で、家具のように壁を透かしては
// いけない（`BUCKET_RANK` の経緯——家具を壁より後に塗っていた頃、画素の 2 割が
// 嘘をついていた）。色は躯体と紛れないように家具の色を使う。
//
// **交差させると破れる。** 離して置くぶんには深さ順で正しく並ぶが、2 つを
// 食い込ませると面ごと入れ替わって見える。面を割る木（BSP）が要る。

const SOLID_COLOR = theme.furniture3d;

/** 回転体の経線の本数。球は 24 × 12 帯 ＝ 288 面になる */
const MERIDIANS = 24;

/** 球の緯線の帯の数。半球はこの半分 */
const PARALLELS = 12;

const solidFace = (points: Vec3[], src: FaceSource): Face3 =>
  polygonFace(points, SOLID_COLOR, "wall", src);

/** ローカルの水平な円を 1 周。反時計回り（上から見て）なので上面の法線が +z になる */
function ringOf(r: number, z: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < MERIDIANS; i++) {
    const a = (i / MERIDIANS) * Math.PI * 2;
    out.push(p3(vec(Math.cos(a) * r, Math.sin(a) * r), z));
  }
  return out;
}

/** 隣と同じ点を落とす。極では四角形が三角形に潰れる */
function dedupe(points: Vec3[]): Vec3[] {
  return points.filter((p, i) => {
    const q = points[(i + points.length - 1) % points.length];
    return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) > 1e-6;
  });
}

/**
 * 水平な輪を下から積んで回転体にする。半径 0 の輪は 1 点に潰れ、その帯は三角形になる。
 *
 * 円錐・球・半球がこれ 1 本で出る。**蓋は半径が 0 でないときだけ張る**
 * （円錐の頂点に蓋を張ると、面積 0 の面が 1 枚増えてソートを濁らせる）。
 */
function revolve(
  rings: { r: number; z: number }[],
  src: FaceSource,
  out: Face3[],
): void {
  const rows = rings.map((ring) =>
    ring.r < 1e-6 ? [p3(vec(0, 0), ring.z)] : ringOf(ring.r, ring.z),
  );

  for (let j = 0; j + 1 < rows.length; j++) {
    const lo = rows[j];
    const hi = rows[j + 1];
    for (let i = 0; i < MERIDIANS; i++) {
      const k = (i + 1) % MERIDIANS;
      const quad = dedupe([
        lo[i % lo.length],
        lo[k % lo.length],
        hi[k % hi.length],
        hi[i % hi.length],
      ]);
      if (quad.length >= 3) out.push(solidFace(quad, src));
    }
  }

  // 下の蓋は裏返して法線を -z に向ける。上の蓋はそのまま +z
  const bottom = rows[0];
  const top = rows[rows.length - 1];
  if (bottom.length > 1) out.push(solidFace([...bottom].reverse(), src));
  if (top.length > 1) out.push(solidFace(top, src));
}

/** 底面を押し出すだけのソリッド。直方体・三角柱・垂直の円筒 */
const prismSolid: SolidBuilder = (f, level, src, out) => {
  const { z0, z1 } = localRange(f, level);
  if (hasTopBottomEdge(f.edge)) {
    extrudeProfile(f, localOutline(f), z0, z1, SOLID_COLOR, src, out);
    return;
  }
  extrudePrism(localOutline(f), z0, z1, SOLID_COLOR, "wall", src, out);
};

/**
 * 段を積んで押し出す。テーパ・面取り・丸めがこれ 1 本で出る。
 *
 * **側面が平面でなくなる段がある**（縮めながら上がるところ）ので、
 * 四角形ではなく**三角形 2 枚**で出す。四角形のまま出すと、4 点が
 * 同一平面に乗らず、`faceNormal` が代表の向きしか返せない。
 *
 * 縮めきって輪郭が潰れた段は**そこで打ち切る**（`insetOutline` が null）。
 * 黙って裏返った形を作るより、少し寸胴になるほうがよい。
 */
function extrudeProfile(
  f: Fixture,
  world: Vec[],
  z0: number,
  z1: number,
  color: string,
  src: FaceSource,
  out: Face3[],
): void {
  const height = z1 - z0;
  if (height < 1e-6 || world.length < 3) return;
  const rings = edgeRings(f.edge!, height, maxInsetOf(world));

  const rows: { z: number; points: Vec[] }[] = [];
  for (const ring of rings) {
    const points = insetOutline(world, ring.inset);
    if (!points) break; // 潰れた。ここまでで打ち切る
    rows.push({ z: z0 + ring.dz, points });
  }
  if (rows.length < 2) {
    extrudePrism(world, z0, z1, color, "wall", src, out);
    return;
  }
  // 上まで届かなかったら、最後の輪郭をまっすぐ伸ばして閉じる
  const last = rows[rows.length - 1];
  if (last.z < z1 - 1e-6) rows.push({ z: z1, points: last.points });

  const n = world.length;
  for (let r = 0; r + 1 < rows.length; r++) {
    const lo = rows[r];
    const hi = rows[r + 1];
    if (Math.abs(hi.z - lo.z) < 1e-9 && samePoints(lo.points, hi.points))
      continue;
    for (let i = 0; i < n; i++) {
      const k = (i + 1) % n;
      const a = p3(lo.points[i], lo.z);
      const b = p3(lo.points[k], lo.z);
      const c = p3(hi.points[k], hi.z);
      const d = p3(hi.points[i], hi.z);
      // **三角形 2 枚。** 縮めながら上がる段では 4 点が同一平面に乗らない。
      // 輪郭は反時計回り（上から見て）なので、この並びで外を向く
      pushIfReal(out, [a, b, c], color, src);
      pushIfReal(out, [a, c, d], color, src);
    }
  }
  // 蓋。下は裏返して法線を下へ
  pushIfReal(
    out,
    rows[0].points.map((p) => p3(p, rows[0].z)).reverse(),
    color,
    src,
  );
  const top = rows[rows.length - 1];
  pushIfReal(
    out,
    top.points.map((p) => p3(p, top.z)),
    color,
    src,
  );
}

const samePoints = (a: readonly Vec[], b: readonly Vec[]): boolean =>
  a.length === b.length &&
  a.every((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y) < 1e-9);

/** 面積のある面だけ入れる。潰れた三角形は塗っても見えず、ソートを濁らせるだけ */
function pushIfReal(
  out: Face3[],
  points: Vec3[],
  color: string,
  src: FaceSource,
): void {
  if (points.length < 3) return;
  const face = polygonFace(points, color, "wall", src);
  if (!Number.isFinite(face.normal.x)) return;
  out.push(face);
}

/** 円錐。底の輪 1 つと頂点 1 つ */
const cone: SolidBuilder = (f, level, src, out) => {
  const { z0, z1 } = localRange(f, level);
  revolve(
    [
      { r: f.size.w / 2, z: z0 },
      { r: 0, z: z1 },
    ],
    src,
    out,
  );
};

/**
 * 球。**水平の径は `size.w`、垂直の径は高さ**なので、高さを変えると回転楕円体になる。
 * 既定（直径 600・高さ 600）では真球。
 */
const sphere: SolidBuilder = (f, level, src, out) => {
  const { z0, z1 } = localRange(f, level);
  const rh = f.size.w / 2;
  const rz = (z1 - z0) / 2;
  const cz = (z0 + z1) / 2;
  const rings = [];
  for (let j = 0; j <= PARALLELS; j++) {
    const phi = -Math.PI / 2 + (Math.PI * j) / PARALLELS;
    rings.push({ r: rh * Math.cos(phi), z: cz + rz * Math.sin(phi) });
  }
  revolve(rings, src, out);
};

/** 半球。底は平らなので、下の蓋が 1 枚張られる */
const dome: SolidBuilder = (f, level, src, out) => {
  const { z0, z1 } = localRange(f, level);
  const rh = f.size.w / 2;
  const bands = PARALLELS / 2;
  const rings = [];
  for (let j = 0; j <= bands; j++) {
    const phi = (Math.PI / 2) * (j / bands);
    rings.push({ r: rh * Math.cos(phi), z: z0 + (z1 - z0) * Math.sin(phi) });
  }
  revolve(rings, src, out);
};

/**
 * 寝かせた円筒。**断面はローカルの x-z 平面の円で、軸はローカルの y。**
 *
 * 断面の横の径は `size.w`、縦の径は高さ、筒の長さは `size.h`。
 *
 * **いまは `cylinder` を y 軸まわりに 90 度倒しても同じものが作れる**
 * （`Fixture.tilt` が入ったため）。それでも種別として残すのは、
 * 既に保存されたファイルがこの種別を指しているから。
 * ワイヤーも「水平の円筒」「垂直の円筒」を分けて並べている。
 */
const lyingCylinder: SolidBuilder = (f, level, src, out) => {
  const { z0, z1 } = localRange(f, level);
  const rx = f.size.w / 2;
  const rz = (z1 - z0) / 2;
  const cz = (z0 + z1) / 2;
  const half = f.size.h / 2;
  const ends: Vec3[][] = [[], []];
  for (let i = 0; i < MERIDIANS; i++) {
    const a = (i / MERIDIANS) * Math.PI * 2;
    const x = Math.cos(a) * rx;
    const z = cz + Math.sin(a) * rz;
    ends[0].push(p3(vec(x, -half), z));
    ends[1].push(p3(vec(x, half), z));
  }
  for (let i = 0; i < MERIDIANS; i++) {
    const k = (i + 1) % MERIDIANS;
    // 角の増える向きは手前の端から見て時計回りなので、手前 → 奥 の順で外を向く
    out.push(solidFace([ends[0][i], ends[1][i], ends[1][k], ends[0][k]], src));
  }
  // 両端の蓋。向きが逆なので片方だけ裏返す
  out.push(solidFace(ends[0], src));
  out.push(solidFace([...ends[1]].reverse(), src));
};

export const FIXTURE_SOLIDS: Record<FixtureKind, SolidBuilder> = {
  column: structural,
  roundColumn: structural,
  beam: structural,
  stair: steps,
  stairU: steps,
  stairL: steps,
  stairWinder: steps,
  slope: wedge,
  void: nothing,
  // 天窓は屋根の穴。この図面に屋根は無いので、3D には何も出ない
  skylight: nothing,

  box: prismSolid,
  prism: prismSolid,
  cylinder: prismSolid,
  cylinderH: lyingCylinder,
  cone,
  sphere,
  dome,
  // 押し出しは底面を立てるだけ。**凹でも正しい**（`extrudePrism` は凸性を仮定しない）
  extrusion: prismSolid,
};

/** 構造物 1 つぶん */
export function buildFixtureFaces(
  scene: Scene,
  fixtureId: Id,
  out: Face3[],
): void {
  const f = scene.fixtures[fixtureId];
  if (!f) return;
  if (!isSnappable(scene, { type: "fixture", id: fixtureId })) return;
  if (!FIXTURE_SPECS[f.kind].solid) return;
  const src: FaceSource = {
    ref: { type: "fixture", id: fixtureId },
    levelId: f.levelId,
  };
  const level = levelOf(scene, f.levelId);
  for (const face of worldFaces(f, level, src)) out.push(face);
}

/**
 * ワールドに立った面。**ここが「ローカルで組んで、最後に 1 回だけ移す」の出口。**
 *
 * ビルダーはどれもローカル座標で組む（中心が原点、底が z = 0）。向き・傾き・位置・
 * 階の床は、組み上がったあとにまとめて当てる。こうすると
 *
 * - 傾きを**ビルダー 9 本に配らなくてよい**（`extrudePrism` は 2D の多角形しか
 *   受け取れないので、傾きを配ると全部書き直しになる）
 * - 傾きが無いときは「z まわりの回転＋平行移動」に退化し、**面が 1 枚も変わらない**
 *
 * ブーリアンはワールドに移してから掛ける。相手は自分の向きと位置を持っているので、
 * ローカルのままでは同じ座標系に乗らない。
 */
function worldFaces(f: Fixture, level: Level, src: FaceSource): Face3[] {
  if (!FIXTURE_SPECS[f.kind].solid) return [];

  if (f.combine) {
    let acc = worldFaces({ ...f, combine: null }, level, src);
    for (const part of f.combine.parts) {
      acc = csgOperate(acc, worldFaces(part, level, src), f.combine.op);
    }
    // **出どころは母体に揃える。** 切り欠いた面も母体をクリックしたことになる
    return acc.map((face) => ({ ...face, ref: src.ref, levelId: src.levelId }));
  }

  const local: Face3[] = [];
  FIXTURE_SOLIDS[f.kind](f, level, src, local);
  return local.map((face) => place(f, level, face));
}

/** ローカルの面 1 枚をワールドへ。法線は**回すだけ**（切れ端から出し直さない） */
function place(f: Fixture, level: Level, face: Face3): Face3 {
  const lift = level.floorZ + baseOf(f, level);
  const n = rotateToWorld(f, face.normal);
  return {
    ...face,
    points: face.points.map((p) => {
      const q = toWorld3(f, vec(p.x, p.y), p.z);
      return vec3(q.x, q.y, q.z + lift);
    }),
    normal: vec3(n.x, n.y, n.z),
  };
}

/** 構造物の指紋。押し出す側が実際に読む欄だけを並べる */
export function fixtureFingerprint(scene: Scene, id: Id): string {
  const f = scene.fixtures[id];
  if (!f) return "";
  const level = levelOf(scene, f.levelId);
  return [
    f.kind,
    f.x,
    f.y,
    f.angle,
    f.size.w,
    f.size.h,
    f.base,
    f.height,
    // **傾きを忘れない。** 入れ忘れると、倒しても 3D が作り直されない
    f.tilt ? `${f.tilt.x}:${f.tilt.y}` : "-",
    // **しまい込んだ相手も入れる。** 入れ忘れると、相手を直しても 3D が古いまま
    combineFingerprint(f),
    // **稜線の仕上げも入れる。** 入れ忘れると、面取りを変えても 3D が古いまま
    f.edge ? `${f.edge.kind}:${f.edge.size}:${f.edge.where}` : "-",
    // **自前の輪郭を忘れない。** 入れ忘れると、輪郭を変えても指紋が同じままで
    // 3D が作り直されない（キャッシュが効き続ける）
    f.outline ? f.outline.map((p) => `${p.x}:${p.y}`).join(" ") : "-",
    level.floorZ,
    level.wallHeight,
    isSnappable(scene, { type: "fixture", id }) ? 1 : 0,
  ].join(",");
}

import {
  FIXTURE_SPECS, isStairKind, outline, stairTreads, toWorld, verticalRange,
  type Fixture, type FixtureKind,
} from '../core/fixture.ts';
import { isSnappable } from '../core/entity.ts';
import { levelOf, type Level } from '../core/level.ts';
import { vec, type Vec } from '../core/geometry.ts';
import { theme } from '../render/theme.ts';
import type { Id, Scene } from '../core/types.ts';
import { extrudePrism, polygonFace, type Face3, type FaceSource } from './mesh.ts';
import { vec3, type Vec3 } from './mat4.ts';

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
type SolidBuilder = (f: Fixture, level: Level, src: FaceSource, out: Face3[]) => void;

/** 柱と梁は躯体なので壁と同じ色にする */
const structural: SolidBuilder = (f, level, src, out) => {
  const { z0, z1 } = verticalRange(f, level);
  extrudePrism(outline(f), z0, z1, theme.wall3d, 'wall', src, out);
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
  const { z0, z1 } = verticalRange(f, level);
  const treads = stairTreads(f.kind, f.size).treads;
  const rise = (z1 - z0) / treads.length;
  treads.forEach((tread, i) => {
    const poly = tread.poly.map((p) => toWorld(f, p));
    extrudePrism(poly, z0, z0 + rise * (i + 1), theme.furniture3d, 'furniture', src, out);
  });
};

/**
 * 楔。上り口（ローカル y の負側）が下端、上端が上端。
 *
 * `extrudePrism` は上下が平らな角柱しか作れないので、ここだけ面を直に組む。
 * 刻んで階段にすると、スロープなのに段に見える。
 */
const wedge: SolidBuilder = (f, level, src, out) => {
  const { z0, z1 } = verticalRange(f, level);
  const w = f.size.w / 2;
  const h = f.size.h / 2;
  const at = (x: number, y: number): Vec => toWorld(f, vec(x, y));
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

const push = (out: Face3[], points: Vec3[], color: string, src: FaceSource): void => {
  out.push(polygonFace(points, color, 'furniture', src));
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
  polygonFace(points, SOLID_COLOR, 'wall', src);

/** ローカルの水平な円を 1 周。反時計回り（上から見て）なので上面の法線が +z になる */
function ringOf(f: Fixture, r: number, z: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < MERIDIANS; i++) {
    const a = (i / MERIDIANS) * Math.PI * 2;
    out.push(p3(toWorld(f, vec(Math.cos(a) * r, Math.sin(a) * r)), z));
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
function revolve(f: Fixture, rings: { r: number; z: number }[], src: FaceSource, out: Face3[]): void {
  const rows = rings.map((ring) =>
    ring.r < 1e-6 ? [p3(toWorld(f, vec(0, 0)), ring.z)] : ringOf(f, ring.r, ring.z));

  for (let j = 0; j + 1 < rows.length; j++) {
    const lo = rows[j];
    const hi = rows[j + 1];
    for (let i = 0; i < MERIDIANS; i++) {
      const k = (i + 1) % MERIDIANS;
      const quad = dedupe([
        lo[i % lo.length], lo[k % lo.length],
        hi[k % hi.length], hi[i % hi.length],
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
  const { z0, z1 } = verticalRange(f, level);
  extrudePrism(outline(f), z0, z1, SOLID_COLOR, 'wall', src, out);
};

/** 円錐。底の輪 1 つと頂点 1 つ */
const cone: SolidBuilder = (f, level, src, out) => {
  const { z0, z1 } = verticalRange(f, level);
  revolve(f, [{ r: f.size.w / 2, z: z0 }, { r: 0, z: z1 }], src, out);
};

/**
 * 球。**水平の径は `size.w`、垂直の径は高さ**なので、高さを変えると回転楕円体になる。
 * 既定（直径 600・高さ 600）では真球。
 */
const sphere: SolidBuilder = (f, level, src, out) => {
  const { z0, z1 } = verticalRange(f, level);
  const rh = f.size.w / 2;
  const rz = (z1 - z0) / 2;
  const cz = (z0 + z1) / 2;
  const rings = [];
  for (let j = 0; j <= PARALLELS; j++) {
    const phi = -Math.PI / 2 + (Math.PI * j) / PARALLELS;
    rings.push({ r: rh * Math.cos(phi), z: cz + rz * Math.sin(phi) });
  }
  revolve(f, rings, src, out);
};

/** 半球。底は平らなので、下の蓋が 1 枚張られる */
const dome: SolidBuilder = (f, level, src, out) => {
  const { z0, z1 } = verticalRange(f, level);
  const rh = f.size.w / 2;
  const bands = PARALLELS / 2;
  const rings = [];
  for (let j = 0; j <= bands; j++) {
    const phi = (Math.PI / 2) * (j / bands);
    rings.push({ r: rh * Math.cos(phi), z: z0 + (z1 - z0) * Math.sin(phi) });
  }
  revolve(f, rings, src, out);
};

/**
 * 寝かせた円筒。**断面はローカルの x-z 平面の円で、軸はローカルの y。**
 *
 * `Fixture` は z 軸まわりしか回らないので、水平の筒は種別として持つしかない。
 * 断面の横の径は `size.w`、縦の径は高さ、筒の長さは `size.h`。
 */
const lyingCylinder: SolidBuilder = (f, level, src, out) => {
  const { z0, z1 } = verticalRange(f, level);
  const rx = f.size.w / 2;
  const rz = (z1 - z0) / 2;
  const cz = (z0 + z1) / 2;
  const half = f.size.h / 2;
  const ends: Vec3[][] = [[], []];
  for (let i = 0; i < MERIDIANS; i++) {
    const a = (i / MERIDIANS) * Math.PI * 2;
    const x = Math.cos(a) * rx;
    const z = cz + Math.sin(a) * rz;
    ends[0].push(p3(toWorld(f, vec(x, -half)), z));
    ends[1].push(p3(toWorld(f, vec(x, half)), z));
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
export function buildFixtureFaces(scene: Scene, fixtureId: Id, out: Face3[]): void {
  const f = scene.fixtures[fixtureId];
  if (!f) return;
  if (!isSnappable(scene, { type: 'fixture', id: fixtureId })) return;
  if (!FIXTURE_SPECS[f.kind].solid) return;
  const src: FaceSource = { ref: { type: 'fixture', id: fixtureId }, levelId: f.levelId };
  FIXTURE_SOLIDS[f.kind](f, levelOf(scene, f.levelId), src, out);
}

/** 構造物の指紋。押し出す側が実際に読む欄だけを並べる */
export function fixtureFingerprint(scene: Scene, id: Id): string {
  const f = scene.fixtures[id];
  if (!f) return '';
  const level = levelOf(scene, f.levelId);
  return [
    f.kind, f.x, f.y, f.angle, f.size.w, f.size.h, f.base, f.height,
    // **自前の輪郭を忘れない。** 入れ忘れると、輪郭を変えても指紋が同じままで
    // 3D が作り直されない（キャッシュが効き続ける）
    f.outline ? f.outline.map((p) => `${p.x}:${p.y}`).join(' ') : '-',
    level.floorZ, level.wallHeight,
    isSnappable(scene, { type: 'fixture', id }) ? 1 : 0,
  ].join(',');
}

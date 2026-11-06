import {
  add,
  boundsOf,
  len,
  lineLineIntersection,
  mul,
  norm,
  signedArea,
  sub,
  vec,
  vec3Like,
  type Vec,
  type Vec3Like,
} from "./geometry.ts";
import {
  baseOf,
  localOutline,
  isBoxFixture,
  isRoundFixture,
  rotateToLocal,
  rotateToWorld,
  specOf,
  type Fixture,
} from "./fixture.ts";
import { hasCornerEdge } from "./edge3d.ts";
import { levelOf, wallHeightOf, type Level } from "./level.ts";
import type { EntityRef, Scene } from "./types.ts";

/**
 * 押し引き（ワイヤー 5 枚目の「プッシュ/プル」）。
 *
 * **壁の天端を掴んで高さを変える操作の一般化。** あれは `wall.height` だけを
 * 書く小さな処理だったが、汎用ソリッドが入ると「立体の面を掴んで押し引きする」
 * ほうが自然な操作になる。**書くのはやはり数値 1〜2 個**で、
 * ノードも輪郭も動かさない。
 *
 * **掴めるのは 4 通り。**
 *
 * | 掴んだ面 | 動くもの | 固定されるもの |
 * |---|---|---|
 * | 壁・立体の上面 | 高さ | 下端 |
 * | 立体の下面 | 下端と高さ | 上端 |
 * | 矩形の立体の側面 | その向きの大きさと中心 | 反対側の面 |
 * | 一般の輪郭の側面 | その辺 1 本 | ほかの辺 |
 *
 * **矩形だけ速い道がある。** `{w, h}` と中心で表せるので輪郭を持たずに済む。
 * 三角・L 形・押し出した形は輪郭そのものを書き換える（`pushOutlineEdge`）。
 *
 * **断るときは理由を出す。** 曲面も、輪郭をまっすぐ押していない種別も押せないが、
 * 黙って `null` を返すと「掴んだのに何も起きない」としか見えない。
 * `pushRefusal` が文言を返し、3D の状況表示がそのまま出す。
 */

/** 高さと大きさの下限 (mm)。インスペクタの `Math.max(1, v)` と揃える */
export const MIN_PUSH_SIZE = 1;

/** 3D の点の最小の形。置き場は `core/geometry.ts` に移した */
export type { Vec3Like };

export type PushWhat = "top" | "bottom" | "side" | "outlineEdge";

export interface PushTarget {
  ref: EntityRef;
  what: PushWhat;
  /**
   * 面の外向き法線（ワールド、単位ベクトル）。押し引きはこの向きに測る。
   *
   * **倒した立体では水平にも鉛直にもならない。** 立体にとっての上面でも、
   * ワールドでは斜めを向く。ドラッグの測り方はこの向きに従う
   */
  normal: Vec3Like;
  /** 鉛直の押し引きか。上面・下面がこれにあたる */
  vertical: boolean;
  /** 側面のときだけ: ローカルのどちらの軸か */
  axis: "x" | "y" | null;
  /** 側面のときだけ: +1 なら +軸側の面 */
  sign: 1 | -1;
  /** `outlineEdge` のときだけ: 動かす辺の番号（**角を落とす前の**輪郭での） */
  edgeIndex: number | null;
  /** 掴んだ時点の値。変位はここからの差で当てる */
  start: {
    base: number;
    height: number;
    w: number;
    h: number;
    x: number;
    y: number;
    /** `outlineEdge` のときだけ: 掴んだ時点の輪郭（角を落とす前） */
    outline: Vec[] | null;
  };
  /** 画面に出す名前 */
  label: string;
}

/**
 * 法線が真上・真下とみなせるか。
 *
 * **立体の場合はローカルで測る。** 倒した箱の上面はワールドでは斜めを向き、
 * z 成分が 0.9 を割る。「立体にとっての上面か」を聞きたいので、
 * 法線をローカルへ戻してから見る。
 */
const UP = 0.9;

/**
 * 掴んだ面が押し引きできるか。できるなら必要な情報を返す。
 *
 * `normal` はワールドの面の法線。`ref` が指すものに合わせて解釈する。
 */
export function pushTargetOf(
  scene: Scene,
  ref: EntityRef,
  normal: Vec3Like,
  at: Vec3Like | null = null,
): PushTarget | null {
  return resolvePush(scene, ref, normal, at).target;
}

/**
 * 押し引きを断った理由。**画面にそのまま出す。**
 *
 * 押せるとき、および言うことが無いときは null。
 *
 * **これが無いと、断ったことが画面のどこにも出ない。** `pushTargetOf` が
 * `null` を返して終わりなので、掴んでも何も起きないように見える。
 */
export function pushRefusal(
  scene: Scene,
  ref: EntityRef,
  normal: Vec3Like,
  at: Vec3Like | null = null,
): string | null {
  return resolvePush(scene, ref, normal, at).why;
}

/**
 * 掴んだ面の判定。**押せるかどうかと、押せない理由を一度に出す。**
 *
 * 判定を `pushTargetOf` と `pushRefusal` に分けて 2 回書くと、片方だけ直した
 * ときに必ず食い違う——「押せないのに理由が出ない」「押せるのに断り書きが
 * 出る」。計算はここ 1 つだけにして、上の 2 つは取り出すだけにしてある。
 */
interface PushResolution {
  target: PushTarget | null;
  /** 断ったときに画面へ出す理由。言うことが無ければ null */
  why: string | null;
}

const ok = (target: PushTarget): PushResolution => ({ target, why: null });
const refuse = (why: string | null): PushResolution => ({ target: null, why });

/**
 * 断る理由の文言。**画面にそのまま出るので、次の一手まで書く。**
 *
 * 「できません」だけだと、使う人は壊れたのか自分の操作が悪いのか分からない。
 */
const WHY_ROUND =
  "丸い面は押せません。直径はプロパティのサイズ欄で変えられます" +
  "（曲面の押し引きは一般的な CAD にもありません）";
const WHY_NOT_EXTRUDED =
  "この種別は輪郭をまっすぐ押し上げた形ではないので、側面は押せません";
const WHY_CORNER_EDGE =
  "縦の角を落とした立体の側面は押せません（上下の面は押せます）";
const WHY_NO_EDGE =
  "どの辺を動かすか決められません。面の真ん中あたりを掴んでください";
const WHY_WALL_SIDE = "壁は天端だけ押せます（厚みはプロパティの欄で）";

function resolvePush(
  scene: Scene,
  ref: EntityRef,
  normal: Vec3Like,
  at: Vec3Like | null,
): PushResolution {
  if (ref.type === "wall") {
    const wall = scene.walls[ref.id];
    if (!wall) return refuse(null);
    // 壁は天端だけ。側面を押すと厚みの話になる
    if (normal.z < UP) return refuse(WHY_WALL_SIDE);
    const level = levelOf(scene, wall.levelId);
    return ok({
      ref,
      what: "top",
      normal: vec3Like(0, 0, 1),
      vertical: true,
      axis: null,
      sign: 1,
      edgeIndex: null,
      start: {
        base: 0,
        height: wallHeightOf(wall, level),
        w: 0,
        h: 0,
        x: 0,
        y: 0,
        outline: null,
      },
      label: "壁の高さ",
    });
  }
  if (ref.type !== "fixture") return refuse(null);
  const f = scene.fixtures[ref.id];
  if (!f || !specOf(f).solid) return refuse(null);
  const level = levelOf(scene, f.levelId);
  const spec = specOf(f);
  const start = {
    base: f.base ?? spec.defaultBase(level),
    height: f.height ?? spec.defaultHeight(level),
    w: f.size.w,
    h: f.size.h,
    x: f.x,
    y: f.y,
    outline: localOutline(f).map((p) => vec(p.x, p.y)),
  };

  // **立体にとっての上下左右で見る。** 倒すとワールドの法線が斜めを向く
  const local = rotateToLocal(f, normal);
  const world = vec3Like(normal.x, normal.y, normal.z);

  if (local.z > UP) {
    return ok({
      ref,
      what: "top",
      normal: world,
      vertical: true,
      axis: null,
      sign: 1,
      edgeIndex: null,
      start,
      label: "高さ",
    });
  }
  if (local.z < -UP) {
    return ok({
      ref,
      what: "bottom",
      normal: world,
      vertical: true,
      axis: null,
      sign: -1,
      edgeIndex: null,
      start,
      label: "下端",
    });
  }

  // --- ここから側面 ---

  // **輪郭をまっすぐ押した立体だけ。** 階段・スロープ・回転体の側面は
  // 輪郭の辺と 1 対 1 に対応しないので、動かした結果を輪郭で表せない
  if (!spec.extruded) return refuse(WHY_NOT_EXTRUDED);
  // **丸い種別は断る。** 32 面の 1 枚を動かしても意味がない
  if (isRoundFixture(f.kind)) return refuse(WHY_ROUND);
  // **縦の角を落としていたら断る。** 理由が 2 つある。
  // ① 面が輪郭の辺と 1 対 1 でなくなり、面取りの面を掴んだときにどの辺か
  //    決められない
  // ② 書き戻す先は `f.outline`（角を落とす**前**の輪郭）なのに、ここで見ている
  //    のは落とした**後**の輪郭。そのまま書き戻すと角が二重に落ちる
  //
  // **この断りを緩めるなら、`baseOutline` に相当するものが要る。**
  if (hasCornerEdge(f.edge)) return refuse(WHY_CORNER_EDGE);

  // 矩形は速い道のまま。`{w, h}` と中心で表せるので、輪郭を持たずに済む
  if (isBoxFixture(f.kind) && !f.outline) {
    const axis: "x" | "y" = Math.abs(local.x) >= Math.abs(local.y) ? "x" : "y";
    const sign: 1 | -1 = (axis === "x" ? local.x : local.y) >= 0 ? 1 : -1;
    return ok({
      ref,
      what: "side",
      normal: world,
      vertical: false,
      axis,
      sign,
      edgeIndex: null,
      start,
      label: axis === "x" ? "幅" : "奥行",
    });
  }

  // 一般の輪郭。掴んだ面がどの辺かを突き止める
  const index = edgeUnder(
    start.outline ?? [],
    local,
    at ? toLocalPoint(f, level, at) : null,
  );
  if (index === null) return refuse(WHY_NO_EDGE);
  return ok({
    ref,
    what: "outlineEdge",
    normal: world,
    vertical: false,
    axis: null,
    sign: 1,
    edgeIndex: index,
    start,
    label: "辺",
  });
}

/**
 * 掴んだ面がローカルの輪郭のどの辺か。
 *
 * **法線だけでは決まらない。** L 字の輪郭には同じ向きの辺が 2 本あるので、
 * 掴んだ点（ローカル）を使って近いほうを採る。点が無ければ、向きが合う辺が
 * 1 本だけのときに限って返す——**当てずっぽうで別の辺を動かさない。**
 */
function edgeUnder(
  poly: readonly Vec[],
  local: Vec3Like,
  at: Vec | null,
): number | null {
  if (poly.length < 3) return null;
  const want = norm(vec(local.x, local.y));
  if (len(want) < 0.5) return null;

  const matched: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const n = outwardNormal(poly, i);
    if (n && n.x * want.x + n.y * want.y > NORMAL_MATCH) matched.push(i);
  }
  if (matched.length === 0) return null;
  if (matched.length === 1) return matched[0];
  if (!at) return null;

  let best = matched[0];
  let bestD = Infinity;
  for (const i of matched) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const m = vec((a.x + b.x) / 2, (a.y + b.y) / 2);
    const d = Math.hypot(m.x - at.x, m.y - at.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** 反時計回りの輪郭の、辺 `i` の外向き法線（単位）。潰れていれば null */
function outwardNormal(poly: readonly Vec[], i: number): Vec | null {
  const a = poly[i];
  const b = poly[(i + 1) % poly.length];
  const d = sub(b, a);
  if (len(d) < 1e-9) return null;
  // 反時計回りなら、進行方向の右が外
  return norm(vec(d.y, -d.x));
}

/** ワールドの点を、立体のローカルの 2 次元へ */
function toLocalPoint(f: Fixture, level: Level, at: Vec3Like): Vec {
  const floor = level.floorZ + baseOf(f, level);
  const d = rotateToLocal(f, vec3Like(at.x - f.x, at.y - f.y, at.z - floor));
  return vec(d.x, d.y);
}

/** これ以上そろっていれば「同じ向きの面」とみなす */
const NORMAL_MATCH = 0.99;

/**
 * 変位 `d`（面の外向き法線の向き、mm）を当てる。**掴んだ時点の値からの差**で
 * 計算するので、同じドラッグ中に何度呼んでも積み上がらない。
 */
export function applyPush(
  scene: Scene,
  target: PushTarget,
  d: number,
): boolean {
  const { start } = target;
  if (target.ref.type === "wall") {
    const wall = scene.walls[target.ref.id];
    if (!wall) return false;
    wall.height = Math.max(MIN_PUSH_SIZE, start.height + d);
    return true;
  }
  const f = scene.fixtures[target.ref.id];
  if (!f) return false;

  if (target.what === "top") {
    f.height = Math.max(MIN_PUSH_SIZE, start.height + d);
    return true;
  }
  if (target.what === "bottom") {
    // **上端を動かさない。** 下へ押せば下端が下がり、そのぶん背が伸びる
    const height = Math.max(MIN_PUSH_SIZE, start.height + d);
    // 原点（底面の中心）はローカルの z に沿って動く。倒していれば横にも動く
    const shift = rotateToWorld(f, vec3Like(0, 0, start.height - height));
    f.base = start.base + shift.z;
    f.height = height;
    if (shift.x !== 0 || shift.y !== 0) {
      f.x = start.x + shift.x;
      f.y = start.y + shift.y;
    }
    return true;
  }

  if (target.what === "outlineEdge") return pushOutlineEdge(f, target, d);

  // 側面。反対側の面を固定したまま、押した側だけを動かす
  const size = Math.max(
    MIN_PUSH_SIZE,
    (target.axis === "x" ? start.w : start.h) + d,
  );
  const grew = size - (target.axis === "x" ? start.w : start.h);
  if (target.axis === "x") f.size.w = size;
  else f.size.h = size;
  // 原点は伸びたぶんの半分だけ、押した向きへ動く。
  // **倒していれば上下にも動く**ので、下端も書き足す
  const half = (grew / 2) * target.sign;
  const shift = rotateToWorld(
    f,
    target.axis === "x" ? vec3Like(half, 0, 0) : vec3Like(0, half, 0),
  );
  f.x = start.x + shift.x;
  f.y = start.y + shift.y;
  if (shift.z !== 0) f.base = start.base + shift.z;
  return true;
}

/**
 * 輪郭の辺を 1 本だけ外へずらす。**両隣の辺の線と交わらせて、形を閉じ直す。**
 *
 * 矩形なら `{w, h}` と中心で表せるが、三角柱や押し出した形ではそれができない。
 * 代わりに**輪郭そのものを書き換える**——以後この立体は自前の輪郭を持つ。
 *
 * **両隣と平行なら断る。** 交点が無いので、動かした結果が閉じない。
 * **裏返ったら断る。** 行きすぎて他の辺を追い越した形は、面積の符号で分かる。
 */
function pushOutlineEdge(f: Fixture, target: PushTarget, d: number): boolean {
  const poly = target.start.outline;
  const i = target.edgeIndex;
  if (!poly || i === null || poly.length < 3) return false;
  const n = poly.length;
  const dir = outwardNormal(poly, i);
  if (!dir) return false;

  const j = (i + 1) % n;
  const a = add(poly[i], mul(dir, d));
  const b = add(poly[j], mul(dir, d));
  // 両隣の辺の線（元のまま）と交わらせる。**両隣は `prev → poly[i]` と
  // `next → poly[j]` の向きで渡す**——交点のパラメータ `t` が 1 の側に
  // 動かす頂点が来るので、`t` が 0 を割ったら「隣の頂点を追い越した」と分かる
  const prev = poly[(i - 1 + n) % n];
  const next = poly[(j + 1) % n];
  const hitA = lineLineIntersection(prev, poly[i], a, b);
  const hitB = lineLineIntersection(next, poly[j], a, b);
  if (!hitA || !hitB) return false;
  // **隣の頂点を追い越したら断る。** 面積の符号では捕まらない——
  // 三角形の底辺を頂点の向こうまで押すと、小さい三角形が**反時計回りのまま**残る
  if (hitA.t < OVERRUN || hitB.t < OVERRUN) return false;

  const moved = poly.map((p, k) =>
    k === i ? hitA.point : k === j ? hitB.point : vec(p.x, p.y),
  );
  // 念のため、潰れた形も断る
  if (signedArea(moved) < MIN_PUSH_AREA) return false;

  f.outline = moved;
  // **幅と奥行も合わせる。** 直さないとプロパティ欄が古い数字を出したままになる
  // （輪郭を持つ立体では `size` は外接矩形の控えでしかない）
  const box = boundsOf(moved);
  if (box) {
    f.size.w = Math.max(MIN_PUSH_SIZE, box.max.x - box.min.x);
    f.size.h = Math.max(MIN_PUSH_SIZE, box.max.y - box.min.y);
  }
  return true;
}

/** 隣の辺を `prev → cur` と測ったときの、追い越していない下限 */
const OVERRUN = 1e-9;

/** これより小さい面積になったら、押しすぎとみなして断る (mm²) */
const MIN_PUSH_AREA = 1;

/**
 * 掴んだ面の外向き法線に沿った軸。ドラッグの測り方を決める。
 *
 * **面の法線そのもの。** 倒していなければ上面は真上、側面は水平になるので、
 * 以前の書き方（鉛直は ±z、側面は法線の水平成分）と同じ向きが出る。
 */
export const pushAxis = (target: PushTarget): Vec3Like => target.normal;

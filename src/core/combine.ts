import { defaultAttrs } from "./attrs.ts";
import {
  FIXTURE_SPECS,
  outline,
  worldZRange,
  type Fixture,
} from "./fixture.ts";
import {
  add,
  boundsOf,
  dot,
  len,
  mul,
  norm,
  sub,
  vec,
  type Vec,
} from "./geometry.ts";
import type { Level } from "./level.ts";
import { newId, type Id, type Scene } from "./types.ts";

/**
 * 立体どうしのブーリアン（ワイヤー 5 枚目の「合成・切り欠き・分割」）。
 *
 * **結果の形を実体として持たない。** ブーリアンの結果は任意のメッシュで、
 * `Fixture`（平面の輪郭＋高さ）では表せない。メッシュを持つ実体を新しく作ると、
 * 平面の記号・ピック・積算・JSON・DXF の全部がそれを知る必要が出る。
 *
 * **代わりに「作り方」を持つ。** 相手の立体を**中へしまい込んで**、
 * 立体を組むときに毎回ブーリアンを掛ける。こうすると
 *
 * - 元の立体はそのまま残るので、**あとから「分解」で戻せる**
 * - しまい込んだものは `scene.fixtures` から消えるので、平面にも積算にも
 *   二重に出ない。**どこかに除外の判定を足す必要が無い**
 * - id の付け替えが要らない（複写は丸ごと複製すればよい）
 *
 * **平面の記号にも出る。** 影どうしのブール演算（`core/polybool.ts`）で起こす。
 * ただし**上から見て本当に変わるときだけ**——箱の真ん中だけをえぐっても
 * 上から見れば箱のままなので、そういう切り欠きは平面に出さない
 * （判断は `core/fixture.ts` の `showsInPlan`）。
 */

export const BOOLEAN_OPS = ["unite", "subtract", "intersect"] as const;

export type BooleanOp = (typeof BOOLEAN_OPS)[number];

export const BOOLEAN_LABELS: Record<BooleanOp, string> = {
  unite: "合成",
  subtract: "切り欠き",
  intersect: "交差",
};

export interface FixtureCombine {
  op: BooleanOp;
  /** しまい込んだ相手。**`scene.fixtures` には入っていない** */
  parts: Fixture[];
}

export const isBooleanOp = (v: unknown): v is BooleanOp =>
  typeof v === "string" && (BOOLEAN_OPS as readonly string[]).includes(v);

/**
 * 1 つめを母体にして、残りをしまい込む。できた母体の id を返す。
 *
 * **立体になる種別だけ**が相手。穴（吹抜・天窓）は立体を持たないので、
 * ブーリアンの相手にならない。
 */
export function combineFixtures(
  scene: Scene,
  ids: readonly Id[],
  op: BooleanOp,
): Id | null {
  const solids = ids.filter((id) => scene.fixtures[id]);
  if (solids.length < 2) return null;
  const host = scene.fixtures[solids[0]];
  const parts: Fixture[] = [];
  for (const id of solids.slice(1)) {
    parts.push(scene.fixtures[id]);
    delete scene.fixtures[id];
  }
  // **既に作り方を持っているなら、後ろに足す。** 何度でも重ねられる
  host.combine =
    host.combine && host.combine.op === op
      ? { op, parts: [...host.combine.parts, ...parts] }
      : { op, parts: [...(host.combine?.parts ?? []), ...parts] };
  if (host.combine) host.combine.op = op;
  return host.id;
}

/** しまい込んだものを図面へ戻す。戻した数を返す */
export function explodeFixture(scene: Scene, id: Id): number {
  const host = scene.fixtures[id];
  if (!host?.combine) return 0;
  const parts = host.combine.parts;
  host.combine = null;
  for (const part of parts) scene.fixtures[part.id] = part;
  return parts.length;
}

/** 指紋に混ぜる文字列。**入れ忘れると、相手を変えても 3D が作り直されない** */
export function combineFingerprint(f: Fixture): string {
  if (!f.combine) return "-";
  return (
    `${f.combine.op}:` +
    f.combine.parts
      .map(
        (p) =>
          `${p.kind},${p.x},${p.y},${p.angle},${p.size.w},${p.size.h},${p.base},${p.height}` +
          `,${p.tilt ? `${p.tilt.x}:${p.tilt.y}` : "-"}` +
          `,${p.outline ? p.outline.map((v) => `${v.x}:${v.y}`).join(" ") : "-"}` +
          `,${combineFingerprint(p)}`,
      )
      .join("|")
  );
}

/**
 * 立体を線で 2 つに切り分ける（ワイヤー 5 枚目「分割 / 分解」の「分割」）。
 *
 * **新しい実体は要らなかった。** 結果が 2 つになるからメッシュを持つ実体が
 * 要る、と長らく書いていたが、**「大きな箱との交差」2 つ**で表せる——
 * 平面で切るのは、半空間と交わるのと同じこと。半空間は持てないが、
 * 立体を丸ごと覆う箱なら持てる。
 *
 * **母体の形と輪郭は元のまま。** 片割れの `kind` も `size` も `outline` も
 * 元の立体のもので、交差の相手として箱がしまい込まれるだけ。だから
 * 平面の記号も積算も壊れない——しかも 7 段目で平面がブーリアンを見るように
 * なったので、**切り口は平面にもそのまま出る。**
 *
 * **既に作り方を持つ立体も切れる。** その作り方ごと中へしまう
 * （`parts: [箱, 元の立体（作り方つき）]`）。交差は順番を選ばないので、
 * 「元の形 ∩ 箱 ∩ 元の作り方の結果」で正しく解ける。
 *
 * **切る面は鉛直。** 断面図と同じ作法で、図面の上の線 1 本で切る。
 * 傾いた面で切りたくなったら、そのときに考える。
 *
 * 切り分けた 2 つの id を返す。立体でないもの・線が短すぎるものは null。
 */
export function splitFixture(
  scene: Scene,
  id: Id,
  a: Vec,
  b: Vec,
  level: Level,
): [Id, Id] | null {
  const host = scene.fixtures[id];
  if (!host || !FIXTURE_SPECS[host.kind].solid) return null;
  const along = sub(b, a);
  if (len(along) < 1) return null;

  const span = outline(host, level);
  const box = boundsOf(span);
  if (!box) return null;
  const z = worldZRange(host, level);

  const dir = norm(along);
  const side = vec(-dir.y, dir.x);
  const centre = vec((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2);

  // **線が立体を横切っていなければ断る。** 片方が空になるだけで、
  // 「切り分けた」ことにならない。断面図が「その線は壁を横切っていません」と
  // 断るのと同じ作法
  let left = false;
  let right = false;
  for (const p of span) {
    const d = dot(sub(p, a), side);
    if (d > CUT_EPS) left = true;
    if (d < -CUT_EPS) right = true;
  }
  if (!left || !right) return null;

  // 立体を丸ごと覆う大きさ。対角の 2 倍あれば、どう切っても足りる
  const reach =
    Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y) * 2 + 1;
  const height = z.z1 - z.z0;
  const margin = height + 1;

  // 線の上で、立体の中心にいちばん近いところ
  const foot = add(a, mul(dir, dot(sub(centre, a), dir)));

  const halves = [1, -1].map((sign) => {
    const knife = cutBox(
      host,
      level,
      add(foot, mul(side, (reach / 2) * sign)),
      Math.atan2(dir.y, dir.x),
      reach,
      z.z0 - margin,
      height + margin * 2,
    );
    const inner: Fixture[] = host.combine
      ? [{ ...structuredClone(host), id: newId("f") }]
      : [];
    return {
      ...structuredClone(host),
      id: newId("f"),
      combine: { op: "intersect" as const, parts: [knife, ...inner] },
    };
  });

  // **元の id を片方に残す。** 選択も undo も、切る前の続きとして扱える
  const keep: Fixture = { ...halves[0], id };
  const made = halves[1];
  scene.fixtures[id] = keep;
  scene.fixtures[made.id] = made;
  return [id, made.id];
}

/** 切り落とす側を覆う箱。中心・向き・大きさだけを持つ素の直方体 */
function cutBox(
  host: Fixture,
  level: Level,
  at: Vec,
  angle: number,
  reach: number,
  z0: number,
  height: number,
): Fixture {
  return {
    id: newId("f"),
    kind: "box",
    x: at.x,
    y: at.y,
    angle,
    tilt: null,
    size: { w: reach, h: reach },
    outline: null,
    combine: null,
    edge: null,
    base: z0 - level.floorZ,
    height,
    label: "",
    layerId: host.layerId,
    levelId: host.levelId,
    attrs: defaultAttrs(),
  };
}

/** 線のどちら側かを見るときの許し (mm)。辺の上に乗った頂点を数えない */
const CUT_EPS = 1e-6;

import type { Fixture } from './fixture.ts';
import type { Id, Scene } from './types.ts';

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
 * **平面の記号は元の輪郭のまま。** 切り欠いた形を平面に出すには、
 * 3D の結果を水平に切って輪郭を起こすことになる。そこまではやらず、
 * **そうであることを画面と文書に書く**。
 */

export const BOOLEAN_OPS = ['unite', 'subtract', 'intersect'] as const;

export type BooleanOp = (typeof BOOLEAN_OPS)[number];

export const BOOLEAN_LABELS: Record<BooleanOp, string> = {
  unite: '合成',
  subtract: '切り欠き',
  intersect: '交差',
};

export interface FixtureCombine {
  op: BooleanOp;
  /** しまい込んだ相手。**`scene.fixtures` には入っていない** */
  parts: Fixture[];
}

export const isBooleanOp = (v: unknown): v is BooleanOp =>
  typeof v === 'string' && (BOOLEAN_OPS as readonly string[]).includes(v);

/**
 * 1 つめを母体にして、残りをしまい込む。できた母体の id を返す。
 *
 * **立体になる種別だけ**が相手。穴（吹抜・天窓）は立体を持たないので、
 * ブーリアンの相手にならない。
 */
export function combineFixtures(scene: Scene, ids: readonly Id[], op: BooleanOp): Id | null {
  const solids = ids.filter((id) => scene.fixtures[id]);
  if (solids.length < 2) return null;
  const host = scene.fixtures[solids[0]];
  const parts: Fixture[] = [];
  for (const id of solids.slice(1)) {
    parts.push(scene.fixtures[id]);
    delete scene.fixtures[id];
  }
  // **既に作り方を持っているなら、後ろに足す。** 何度でも重ねられる
  host.combine = host.combine && host.combine.op === op
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
  if (!f.combine) return '-';
  return `${f.combine.op}:` + f.combine.parts
    .map((p) => `${p.kind},${p.x},${p.y},${p.angle},${p.size.w},${p.size.h},${p.base},${p.height}`
      + `,${p.outline ? p.outline.map((v) => `${v.x}:${v.y}`).join(' ') : '-'}`
      + `,${combineFingerprint(p)}`)
    .join('|');
}
